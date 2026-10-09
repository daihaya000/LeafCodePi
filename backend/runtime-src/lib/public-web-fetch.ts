import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Parser } from "htmlparser2";
import { Agent, fetch } from "undici";
import { isSensitivePreviewUrl, normalizeLinkUrl } from "@/lib/link-preview-shared";

const blocked4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked4.addSubnet(address, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const blocked6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blocked6.addSubnet(address, prefix, "ipv6");
}
export function isPublicWebAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked4.check(address, "ipv4")
    : family === 6 && global6.check(address, "ipv6") && !blocked6.check(address, "ipv6");
}
function publicUrl(value: string): URL {
  const normalized = normalizeLinkUrl(value);
  if (!normalized) throw new Error("Invalid public URL");
  const url = new URL(normalized);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host) ? !isPublicWebAddress(host) : !host.includes(".") || /(?:^|\.)(?:localhost|local|internal)$/.test(host)) {
    throw new Error("Non-public host");
  }
  return url;
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([work(), stopped]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** No cookies/proxy/environment credentials. Pin the checked DNS answer to every new connection. */
export async function fetchPublicWebBytes(value: string, options: {
  maxBytes: number; accept: string; prefix?: boolean; signal?: AbortSignal; noSensitiveLinks?: boolean; allowImageSignatures?: boolean;
}): Promise<{ bytes: Buffer; contentType: string; url: string }> {
  assertConfigurationOwner();
  const timeout = AbortSignal.timeout(6000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let url = publicUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    if (options.noSensitiveLinks && isSensitivePreviewUrl(url.href, options.allowImageSignatures)) throw new Error("Sensitive preview link");
    url.hash = "";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(host);
    const addresses = family ? [{ address: host, family }] : await abortable(() => lookup(host, { all: true, verbatim: true }), signal);
    if (!addresses.length || addresses.some((item) => !isPublicWebAddress(item.address))) throw new Error("Non-public DNS answer");
    const dispatcher = new Agent({
      connections: 1, headersTimeout: 3000, bodyTimeout: 3000,
      connect: {
        timeout: 3000,
        lookup: (_hostname, settings, callback) => {
          if (settings.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        },
      },
    });
    try {
      const response = await fetch(url.href, {
        dispatcher, signal, redirect: "manual",
        headers: { accept: options.accept, "user-agent": "LeafCodePi-LinkPreview/1.0" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new Error("Redirect limit");
        url = publicUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Unavailable page"); }
      const contentType = response.headers.get("content-type") ?? "";
      const contentLength = Number(response.headers.get("content-length"));
      if (!options.prefix && contentLength > options.maxBytes) { await response.body.cancel(); throw new Error("Response too large"); }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      let headEnded = false;
      // Latin-1 maps one byte to one code unit, retaining exact byte offsets across chunks.
      const headParser = options.prefix ? new Parser({
        onclosetag(name) { if (name === "head") { headEnded = true; headParser?.pause(); } },
        onopentag(name) { if (name === "body") { headEnded = true; headParser?.pause(); } },
      }) : undefined;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          const available = options.maxBytes - size;
          if (!options.prefix && item.value.byteLength > available) throw new Error("Response too large");
          const incoming = item.value.subarray(0, available);
          headParser?.write(Buffer.from(incoming.buffer, incoming.byteOffset, incoming.byteLength).toString("latin1"));
          const keep = headEnded ? Math.max(0, Math.min(incoming.length, headParser!.endIndex + 1 - size)) : incoming.length;
          const chunk = Buffer.from(incoming.subarray(0, keep));
          chunks.push(chunk);
          size += chunk.length;
          if (options.prefix && (size === options.maxBytes || headEnded)) break;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return { bytes: Buffer.concat(chunks, size), contentType, url: url.href };
    } finally { await dispatcher.destroy(); }
  }
  throw new Error("Redirect limit");
}
