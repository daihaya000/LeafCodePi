import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";
import { PROVIDER_AUTH_BUFFER_LIMIT } from "../../shared/provider-auth-contract.mjs";
/** Bounded socket bridge; disconnect only cancels the subscriber, never the authentication session. */
export async function streamProviderLoginEvents(response, source, signal) {
  if (source.status !== 200 || !source.body || !source.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("Invalid login event stream");
  const reader = source.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) { cancel(); return; }
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-cache, no-transform", [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) });
  response.flushHeaders();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done || signal.aborted) break;
      if (value.byteLength > PROVIDER_AUTH_BUFFER_LIMIT || response.writableLength > PROVIDER_AUTH_BUFFER_LIMIT) throw new Error("Login stream overflow");
      if (!response.write(value)) await new Promise((resolve, reject) => {
        const finish = error => { clearTimeout(timer); response.off("drain", drain); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
        const drain = () => finish(), abort = () => finish(new Error("Closed"));
        const timer = setTimeout(() => finish(new Error("Stalled")), 45_000); timer.unref?.();
        response.once("drain", drain); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    if (!response.destroyed) response.end();
  } catch { response.destroy(); }
  finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); }
}
