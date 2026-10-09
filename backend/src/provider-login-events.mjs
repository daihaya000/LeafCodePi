import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";
import { PROVIDER_AUTH_EVENT_LIMIT } from "../../shared/provider-auth-contract.mjs";
const stats = { readers: 0, drainWaiters: 0 };
export const readProviderLoginTransportDiagnostics = () => ({ ...stats });
/** Bounded socket bridge; disconnect cancels only the subscriber, never authentication. */
export async function streamProviderLoginEvents(response, source, signal, { stallMs = 45000 } = {}) {
  if (source.status !== 200 || !source.body || !source.headers.get("content-type")?.startsWith("text/event-stream")) {
    await source.body?.cancel().catch(() => {});
    if (!signal.aborted && !response.destroyed) { response.writeHead(503, { [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION), "cache-control": "private, no-store" }); response.end(); }
    return;
  }
  const reader = source.body.getReader(); stats.readers++;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted || response.destroyed) return;
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "private, no-store, no-cache, no-transform", "x-content-type-options": "nosniff", [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) });
    response.flushHeaders();
    for (;;) {
      const { done, value } = await reader.read(); if (done || signal.aborted || response.destroyed) break;
      if (value.byteLength > PROVIDER_AUTH_EVENT_LIMIT || response.writableLength + value.byteLength > 2 * PROVIDER_AUTH_EVENT_LIMIT) throw new Error("Login stream overflow");
      if (!response.write(value)) await new Promise((resolve, reject) => {
        stats.drainWaiters++; let settled = false;
        const finish = error => { if (settled) return; settled = true; stats.drainWaiters--; clearTimeout(timer); response.off("drain", drain); response.off("close", abort); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
        const drain = () => finish(), abort = () => finish(new Error("Closed"));
        const timer = setTimeout(() => finish(new Error("Stalled")), stallMs); timer.unref?.();
        response.once("drain", drain); response.once("close", abort); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted || response.destroyed) abort();
      });
    }
    if (!signal.aborted && !response.destroyed) response.end();
  } catch { response.destroy(); }
  finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); stats.readers--; }
}
