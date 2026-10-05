import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";

/** Buffered bytes a live consumer may lag behind before the transport is dropped. */
export const RUNTIME_EVENTS_MAX_BUFFERED_BYTES = 1024 * 1024;
/** How long a consumer may leave the socket undrained before it counts as stalled. */
export const RUNTIME_EVENTS_STALL_MS = 45_000;

/**
 * Bounded SSE transport for the owner's process-local Bot/routine buses.
 *
 * `write() === false` only means the socket buffer passed its high-water mark (16 KiB). On
 * Windows libuv flushes asynchronously, so a burst of small events reaches that mark on a healthy
 * consumer; dropping the stream there cut the WebUI relay mid-stream ("other side closed"). The
 * stream is dropped only when the backlog exceeds the byte cap or no drain arrives in time.
 *
 * While the socket is above high-water, further event payloads are skipped (dirty/snapshot/routine
 * are recoverable via reconnect or idle poll). Heartbeats still write so a dead peer fails the
 * stall window. The inbound `request` must be passed so a peer FIN destroys our half — otherwise
 * Windows accumulates CLOSE_WAIT and the HTTP server eventually stops answering.
 */
export function streamRuntimeEvents(response, subscribe, {
  heartbeatMs = 15_000,
  maxBufferedBytes = RUNTIME_EVENTS_MAX_BUFFERED_BYTES,
  stallMs = RUNTIME_EVENTS_STALL_MS,
  now = Date.now,
  request = null,
} = {}) {
  let unsubscribe = () => {};
  let heartbeat;
  let closed = false;
  let undrainedSince = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (request) {
      request.off?.("close", onRequestGone);
      request.off?.("aborted", onRequestGone);
    }
    try { unsubscribe(); } catch { /* Disconnect must never crash the runtime owner. */ }
  };
  const drop = () => {
    cleanup();
    try { response.destroy(); } catch { /* Already closed. */ }
  };
  const onRequestGone = () => { drop(); };
  const write = (chunk, { force = false } = {}) => {
    if (closed) return false;
    // Backpressure: skip recoverable event frames while the kernel buffer is full. Forced writes
    // (connected comment, heartbeats) still probe liveness and advance the stall clock.
    if (!force && undrainedSince !== null) return false;
    try {
      if (!response.write(chunk)) undrainedSince ??= now();
      if ((response.writableLength ?? 0) > maxBufferedBytes) { drop(); return false; }
      return true;
    } catch { drop(); return false; }
  };
  response.once("close", cleanup);
  response.once("error", cleanup);
  response.on("drain", () => { undrainedSince = null; });
  if (request) {
    request.once("close", onRequestGone);
    request.once("aborted", onRequestGone);
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-cache, no-transform",
    [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
  });
  response.flushHeaders();
  try {
    unsubscribe = subscribe(({ event, payload }) => {
      if (closed || !["snapshot", "routine", "task_dirty"].includes(event)) return;
      write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    });
    if (closed) { unsubscribe(); return; }
    write(": connected\n\n", { force: true });
    heartbeat = setInterval(() => {
      if (closed) return;
      // A consumer that has not drained for stallMs is gone; EventSource reconnects.
      if (undrainedSince !== null && now() - undrainedSince >= stallMs) { drop(); return; }
      write(": heartbeat\n\n", { force: true });
    }, heartbeatMs);
    heartbeat.unref?.();
  } catch { drop(); }
}
