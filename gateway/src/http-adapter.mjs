import { Readable } from "node:stream";
import { once } from "node:events";

/** Raw adapter by default; the gateway supplies the legacy bind origin separately from Host. */
export function requestUrl(message, { hostname, port } = {}) {
  const host = message.headers.host;
  if (!host || host.length > 512 || /[\s\\/@?#,]/.test(host) || !message.url?.startsWith("/")) throw new TypeError("Invalid request authority");
  const scheme = message.socket.encrypted || message.headers["x-forwarded-proto"]?.includes("https") ? "https" : "http";
  const url = new URL(`${scheme}://${host}${message.url}`);
  if (!url.hostname || url.username || url.password) throw new TypeError("Invalid request URL");
  if (hostname) {
    // Next initialized handler URLs from its bind address, then normalized loopback to localhost.
    const bound = new URL(`${scheme}://${hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname}:${port}/`);
    if (/^(?:127(?:\.\d{1,3}){3}|\[::1\]|localhost)$/.test(bound.hostname)) bound.hostname = "localhost";
    url.host = bound.host;
  }
  return url;
}

export function toWebRequest(message, response, options = {}) {
  const url = requestUrl(message, options);
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Client disconnected", "AbortError"));
  // IncomingMessage.close also fires after a normally consumed body: that is not cancellation.
  const close = () => { if (!response.writableFinished) abort(); };
  message.once("aborted", abort); response.once("close", close);
  const headers = new Headers();
  // Node already applies the HTTP duplicate-header rules, particularly Cookie's semicolon join.
  for (const [name, value] of Object.entries(message.headers)) if (value !== undefined) {
    for (const part of Array.isArray(value) ? value : [value]) headers.append(name, part);
  }
  if (options.forwarded) {
    const secure = message.socket.encrypted === true;
    for (const [name, value] of Object.entries({ "x-forwarded-host": message.headers.host, "x-forwarded-port": String(message.socket.localPort), "x-forwarded-proto": secure ? "https" : "http", "x-forwarded-for": message.socket.remoteAddress })) {
      if (!headers.has(name) && value !== undefined) headers.set(name, value);
    }
  }
  const body = ["GET", "HEAD"].includes(message.method) ? undefined : Readable.toWeb(message, { strategy: { highWaterMark: 65536, size: chunk => chunk.byteLength } });
  const request = new Request(url, { method: message.method, headers, signal: controller.signal, ...(body ? { body, duplex: "half" } : {}) });
  return { request, cleanup() { message.removeListener("aborted", abort); response.removeListener("close", close); } };
}

function compressionResponse(message, response) {
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  const compressible = /^(?:text\/|application\/(?:json|javascript|xml|wasm)$|image\/svg\+xml$)|\+(?:json|text|xml)$/.test(type);
  // Never buffer a first event behind the compressor. Existing SSE relays also set no-transform.
  if (!compressible || type === "text/event-stream" || /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "")) return response;
  const vary = response.headers.get("vary");
  if (!vary?.split(",").some(value => ["accept-encoding", "*"].includes(value.trim().toLowerCase()))) response.headers.set("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  if (!response.body || message.method === "HEAD" || response.headers.has("content-encoding") || response.headers.has("content-length") && Number(response.headers.get("content-length")) < 1024) return response;
  const accepted = (message.headers["accept-encoding"] ?? "").split(",").map((part, index) => {
    const [name, parameter] = part.trim().toLowerCase().split(";");
    return { name, quality: parameter?.trim().startsWith("q=") ? Number(parameter.trim().slice(2)) : 1, index };
  }).filter(value => value.quality > 0).sort((a, b) => b.quality - a.quality || a.index - b.index);
  const selected = accepted.find(value => ["gzip", "deflate", "identity"].includes(value.name));
  if (!selected || selected.name === "identity") return response;
  // Unknown-length streamed responses are compressed without buffering, just as the old HTTP entry.
  response.headers.set("content-encoding", selected.name); response.headers.delete("content-length");
  return new Response(response.body.pipeThrough(new CompressionStream(selected.name)), { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function writeWebResponse(message, outgoing, response) {
  if (!(response instanceof Response)) throw new TypeError("Handler did not return Response");
  response = compressionResponse(message, response);
  outgoing.statusCode = response.status;
  if (response.statusText) outgoing.statusMessage = response.statusText;
  for (const [name, value] of response.headers) if (name !== "set-cookie") outgoing.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("set-cookie", cookies);
  if (message.method === "HEAD" || [204, 205, 304].includes(response.status) || !response.body) {
    await response.body?.cancel().catch(() => {}); outgoing.end(); return;
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  outgoing.once("close", cancel);
  try {
    outgoing.flushHeaders();
    while (!outgoing.destroyed) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!outgoing.write(value)) {
        // A disconnected socket must also release a producer waiting for drain.
        const controller = new AbortController();
        const stopped = () => controller.abort(); outgoing.once("close", stopped);
        try { if (!outgoing.destroyed) await once(outgoing, "drain", { signal: controller.signal }); }
        catch (error) { if (!outgoing.destroyed) throw error; }
        finally { outgoing.removeListener("close", stopped); }
      }
    }
    if (!outgoing.destroyed) outgoing.end();
  } catch (error) { outgoing.destroy(error); }
  finally { outgoing.removeListener("close", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function nodeHttpHandler(dispatch, options = () => ({})) {
  return async (incoming, outgoing) => {
    let transport;
    try {
      transport = toWebRequest(incoming, outgoing, options(incoming));
      const response = await dispatch(transport.request);
      await writeWebResponse(incoming, outgoing, response);
    } catch {
      if (!outgoing.headersSent && !outgoing.destroyed) {
        outgoing.statusCode = transport ? 500 : 400;
        outgoing.setHeader("content-type", "application/json"); outgoing.end(JSON.stringify({ error: transport ? "Gateway request failed" : "Invalid request" }));
      } else outgoing.destroy();
    } finally { transport?.cleanup(); }
  };
}
