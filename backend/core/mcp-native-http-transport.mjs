import { basename, isAbsolute } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { StreamableHttpTransport } from "@earendil-works/pi-mcp";
const plain = (v) => v && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, keys) => plain(v) && keys.every((key) => Object.hasOwn(v, key));
const only = (v, keys) => Reflect.ownKeys(v).every((key) => keys.includes(key));
const unavailable = () => new Error("MCP HTTP transport unavailable");
const text = (v) => typeof v === "string" && !/[\0\r\n]/.test(v);
const absolute = (v) => text(v) && isAbsolute(v);

/** Cloud metadata hostnames that are not IP literals. */
const METADATA_HOSTNAMES = new Set(["metadata.google.internal", "metadata.goog", "instance-data.ec2.internal"]);
/** Platform endpoints that sit on a public address (Azure's WireServer). */
const METADATA_ADDRESSES = new Set(["168.63.129.16"]);

/**
 * Headers the transport owns: hop-by-hop and framing fields. A configured value would rewrite the
 * virtual host, desync the body framing, or let the endpoint end the stream the SDK still expects,
 * so they are refused instead of silently overridden.
 */
const FORBIDDEN_HEADERS = new Set([
  "host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer",
  "proxy-authorization", "proxy-connection",
]);

/** True for the IPv4 ranges an HTTPS endpoint may not name. Loopback (127/8) is deliberately absent. */
function isPrivateIpv4([first, second, third, fourth]) {
  return first === 0 || first === 10
    || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127)
    || (first === 198 && (second === 18 || second === 19)) || first >= 224
    || METADATA_ADDRESSES.has(`${first}.${second}.${third}.${fourth}`);
}

/** The eight 16-bit groups of an IPv6 literal in the canonical form the URL parser emits, or null. */
function parseIpv6(literal) {
  const halves = literal.split("::");
  if (halves.length > 2) return null;
  const groups = (part) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const values = [...head, ...Array(missing).fill("0"), ...tail]
    .map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));
  return values.some(Number.isNaN) ? null : values;
}

/** True for the IPv6 ranges an HTTPS endpoint may not name, judging an embedded IPv4 address by its own rules. */
function isPrivateIpv6(g) {
  const zero = (from, to) => g.slice(from, to).every((group) => group === 0);
  const embedded = (high, low) => isPrivateIpv4([high >> 8, high & 255, low >> 8, low & 255]);
  if (zero(0, 8)) return true; // :: (unspecified)
  if (zero(0, 6)) return g[6] === 0 && g[7] === 1 ? false : embedded(g[6], g[7]); // ::1 is loopback; ::a.b.c.d is IPv4-compatible
  if (zero(0, 5) && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return embedded(g[6], g[7]); // ::ffff:0:a.b.c.d (IPv4-translated)
  // NAT64: only the well-known /96 embeds an address; the rest of 64:ff9b::/32 is local-use or reserved.
  if (g[0] === 0x64 && g[1] === 0xff9b) return zero(2, 6) ? embedded(g[6], g[7]) : true;
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4 carries the IPv4 address in bits 16-47
  return (g[0] & 0xfe00) === 0xfc00 // unique-local
    || (g[0] & 0xffc0) === 0xfe80 // link-local
    || (g[0] & 0xffc0) === 0xfec0 // site-local (deprecated, still routable inside some networks)
    || (g[0] & 0xff00) === 0xff00; // multicast
}

/**
 * Destinations an HTTPS endpoint may not name: private, link-local, carrier-grade NAT, benchmark and
 * multicast ranges, IPv6 unique-local/link-local/site-local, and cloud metadata names and addresses.
 * An IPv6 literal that embeds an IPv4 address (IPv4-mapped/-compatible/-translated, NAT64, 6to4) is
 * judged by the address it embeds, so `[::ffff:169.254.169.254]` is no way around the IPv4 rules.
 * Loopback stays allowed because the HTTP rule already trusts it explicitly. A DNS name that resolves
 * into one of these ranges is NOT covered (nor a wildcard-DNS name that spells an address, such as
 * `169.254.169.254.nip.io`): this transport resolves nothing and pins nothing, so a hostname can still
 * point inward. Refusing literals only removes the destinations an endpoint can name outright.
 */
function isPrivateDestination(hostname) {
  const bracketed = hostname.startsWith("[") && hostname.endsWith("]");
  // A trailing dot names the same host (`metadata.google.internal.`), and the URL parser keeps it.
  const host = (bracketed ? hostname.slice(1, -1) : hostname).toLowerCase().replace(/\.+$/, "");
  if (METADATA_HOSTNAMES.has(host)) return true;
  // The URL parser already folds IPv4 literals (0177.0.0.1, 2130706433) to dotted decimal.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) return isPrivateIpv4(ipv4.slice(1).map(Number));
  if (!host.includes(":")) return false;
  const groups = parseIpv6(host);
  // An IPv6 literal this check cannot read is not one it can vouch for.
  return groups === null || isPrivateIpv6(groups);
}

/** INTERNAL inert constructor from SDK-validated private snapshot + SAME binding authority.
 * Explicit headers variables/fetch; no config/credential/browser/network IO or ambient env lookup.
 * Variable names that cannot appear in `${NAME}` templates are kept but unreferencable.
 * Fixed global selectors/cwd and immutable MCP endpoint. HTTPS or exact loopback HTTP only;
 * userinfo/fragments/unresolved URLs, !commands, other $NAME/escapes and redirects fail closed.
 * SDK authProvider passes through unchanged: token refresh, OAuth discovery/issuer permissions,
 * pending cancellation and global-fetch use INTERNAL to that provider remain separate gates.
 * The owner fetch MUST enforce its own destination policy (OAuth context.fetch can name an issuer).
 * Start/send/fetch entry/completion are fenced, including retries/GET opens through this fetch.
 * JSON/POST SSE/GET SSE synchronous message dispatch checks authority before/after each listener.
 * Async listener work is not awaited/cancelled (SDK void-listener contract). Observed
 * failure stops delivery, emits an immediate close to release pending SDK requests, then attempts
 * cleanup. Throwing close listeners are isolated; unsubscribe remains usable. Previously delivered
 * messages/callback effects and response/SSE body consumption are NOT rolled back or fully cancelled.
 * Close remains callable; only a close-origin DELETE to the fixed endpoint bypasses authority,
 * best-effort as in the SDK. Private/link-local/metadata destinations are refused for HTTPS, and
 * hop-by-hop/framing headers are refused in both protocols; this is still not DNS pinning, writer
 * quiescence or production activation.
 * Snapshot/headers/URL/options/auth are PRIVATE, never DTOs. Reprepare after source/variable changes.
 */
export function createBackendMcpHttpTransportFactory(options) {
  try {
    const keys = ["snapshot", "configPath", "sessionCwd", "variables", "fetch", "assertSnapshotOwner"];
    if (!own(options, keys) || !only(options, keys)) throw unavailable();
    const captured = Object.fromEntries(keys.map((key) => [key, options[key]]));
    if (!absolute(captured.configPath) || basename(captured.configPath) !== "mcp.json" || !absolute(captured.sessionCwd)
      || typeof captured.fetch !== "function" || typeof captured.assertSnapshotOwner !== "function"
      || types.isAsyncFunction(captured.assertSnapshotOwner) || !plain(captured.variables)) throw unavailable();
    const variables = new Map();
    for (const key of Reflect.ownKeys(captured.variables)) {
      // Only identifier names can be referenced, but an ambient map (process.env) may hold other keys:
      // they are unreferencable rather than a reason to refuse every endpoint.
      if (typeof key !== "string" || !key || key.includes("\0")) throw unavailable();
      const value = captured.variables[key]; if (!text(value)) throw unavailable(); variables.set(key, value);
    }
    const snapshot = structuredClone(captured.snapshot);
    if (!own(snapshot, ["servers", "errors"]) || !only(snapshot, ["servers", "errors", "autoEnableCodemode"])
      || !Array.isArray(snapshot.servers) || !Array.isArray(snapshot.errors) || snapshot.errors.length !== 0) throw unavailable();
    const entries = new Map(), namespaces = new Set();
    for (const entry of snapshot.servers) {
      if (!own(entry, ["name", "source", "scope", "config"]) || !only(entry, ["name", "source", "scope", "config"])
        || typeof entry.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.name) || !plain(entry.config)
        || entry.source !== captured.configPath || entry.scope !== "global" || namespaces.has(entry.name.replaceAll("-", "_"))) throw unavailable();
      entries.set(entry.name, entry); namespaces.add(entry.name.replaceAll("-", "_"));
    }
    const expand = (value) => {
      if (!text(value) || value.startsWith("!") || value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "").includes("$")) throw unavailable();
      const result = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_reference, key) => {
        const item = variables.get(key); if (!item) throw unavailable(); return item;
      });
      if (result.includes("${")) throw unavailable(); return result;
    };
    let fenced = false, checking = false;
    const assertOwner = () => {
      if (fenced || checking) { fenced = true; throw unavailable(); }
      checking = true;
      try {
        const ack = captured.assertSnapshotOwner();
        if (ack && typeof ack.then === "function") { Promise.resolve(ack).catch(() => undefined); throw unavailable(); }
        if (ack !== undefined || fenced) throw unavailable();
      } catch { fenced = true; throw unavailable(); }
      finally { checking = false; }
    };
    return (entry, cwd, authProvider) => {
      try {
        if (checking) { fenced = true; throw unavailable(); }
        const selected = structuredClone(entry), fixed = entries.get(selected?.name);
        if (!fixed || !isDeepStrictEqual(selected, fixed) || cwd !== captured.sessionCwd) throw unavailable();
        const config = fixed.config;
        if (!only(config, ["url", "headers", "oauth", "auth", "type", "enabled", "exposure", "toolExposure", "description", "timeout"])
          || !text(config.url) || config.url.startsWith("!") || config.url.includes("${") || config.enabled === false
          || (config.type !== undefined && !["http", "streamable-http"].includes(config.type))
          || (authProvider !== undefined && (!authProvider || typeof authProvider.token !== "function"
            || (authProvider.onUnauthorized !== undefined && typeof authProvider.onUnauthorized !== "function")))) throw unavailable();
        const url = new URL(config.url);
        if (url.username || url.password || config.url.includes("#") || !(url.protocol === "https:"
          || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
          || (url.protocol === "https:" && isPrivateDestination(url.hostname))) throw unavailable();
        const href = url.href, headers = {}, names = new Set();
        if (!plain(config.headers ?? {})) throw unavailable();
        for (const name of Reflect.ownKeys(config.headers ?? {})) {
          const lower = typeof name === "string" ? name.toLowerCase() : "";
          if (typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || FORBIDDEN_HEADERS.has(lower) || names.has(lower)) throw unavailable();
          Object.defineProperty(headers, name, { value: expand(config.headers[name]), enumerable: true }); names.add(lower);
        }
        new Headers(headers); Object.freeze(headers); // Validate without network IO; never silently omit an invalid header.
        let closing = 0, deliveryStopped = false;
        const fetch = async (input, init) => {
          const cleanup = closing && init?.method === "DELETE" && String(input) === href;
          if (!cleanup) assertOwner();
          let response;
          try {
            response = await Reflect.apply(captured.fetch, undefined, [input, { ...init, redirect: "error" }]);
            if (!cleanup) assertOwner(); return response;
          } catch (error) {
            try { response?.body?.cancel().catch(() => undefined); } catch {}
            if (!cleanup) assertOwner(); throw error;
          }
        };
        class OwnerHttpTransport extends StreamableHttpTransport {
          #stopDelivery() {
            if (deliveryStopped) return;
            deliveryStopped = true;
            try { this.emitError(unavailable()); } catch {} // Cleanup must survive a throwing error observer.
            // SDK onError alone does not reject pending requests. Notify close immediately, even
            // if auth/DELETE cleanup subsequently awaits or fails. This is not completed/drained IO.
            try { this.emitClose(); } finally { void this.close().catch(() => undefined); }
          }
          onMessage(listener) {
            return super.onMessage((message) => {
              if (deliveryStopped) return;
              try { assertOwner(); } catch { this.#stopDelivery(); return; }
              try { listener(message); }
              finally { try { assertOwner(); } catch { this.#stopDelivery(); } }
            });
          }
          onClose(listener) { return super.onClose(() => { try { listener(); } catch {} }); }
          async start() { assertOwner(); try { await super.start(); assertOwner(); } catch (error) { assertOwner(); throw error; } }
          async send(message) { assertOwner(); try { await super.send(message); assertOwner(); } catch (error) { assertOwner(); throw error; } }
          async close() { deliveryStopped = true; closing++; try { await super.close(); } finally { closing--; } }
        }
        assertOwner();
        const transport = new OwnerHttpTransport({ url: href, headers, authProvider, fetch });
        Object.freeze(transport.options.headers);
        Object.defineProperty(transport, "options", { value: transport.options, writable: false, configurable: false, enumerable: true });
        Object.defineProperty(transport, "url", { get: () => new URL(href), configurable: false, enumerable: true });
        assertOwner(); return transport;
      } catch { throw unavailable(); }
    };
  } catch { throw unavailable(); }
}
