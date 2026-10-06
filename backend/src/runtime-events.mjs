import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";

/** Buffered bytes a live consumer may lag behind before the transport is dropped. */
export const RUNTIME_EVENTS_MAX_BUFFERED_BYTES = 1024 * 1024;
/** How long a consumer may leave the socket undrained before it counts as stalled. */
export const RUNTIME_EVENTS_STALL_MS = 45_000;
/** Task wakes remembered while the socket is above high-water, replayed once on drain. */
export const RUNTIME_EVENTS_MAX_DEFERRED_TASK_WAKES = 256;
/** Maximum serialized bytes retained for deferred task wakes, including optional stream deltas. */
export const RUNTIME_EVENTS_MAX_DEFERRED_TASK_WAKE_BYTES = 1024 * 1024;
/** Per-task state wakes/deltas are idempotent and worth replaying instead of dropping. */
const TASK_WAKE_EVENTS = new Set(["task_dirty", "task_stream"]);

/**
 * Bounded SSE transport for the owner's process-local Bot/routine buses.
 *
 * `write() === false` only means the socket buffer passed its high-water mark (16 KiB). On
 * Windows libuv flushes asynchronously, so a burst of small events reaches that mark on a healthy
 * consumer; dropping the stream there cut the WebUI relay mid-stream ("other side closed"). The
 * stream is dropped only when the backlog exceeds the byte cap or no drain arrives in time.
 *
 * While the socket is above high-water, further event payloads are skipped (snapshot/routine are
 * recoverable via reconnect or idle poll). Task wakes (`task_dirty`, `task_stream`) are instead
 * coalesced per task and replayed on drain: a dropped wake left the WebUI waiting for its 30s
 * idle safety-net poll before a sent message appeared. Heartbeats still write so a dead peer
 * fails the stall window.
 *
 * `task_stream` (throttled streaming-text wakes) is only sent to consumers that opt in with
 * `includeStream`, so browser proxies of this stream never carry per-token traffic.
 *
 * The inbound `request` must be passed so a peer FIN destroys our half — otherwise
 * Windows accumulates CLOSE_WAIT and the HTTP server eventually stops answering.
 */
export function streamRuntimeEvents(response, subscribe, {
  heartbeatMs = 15_000,
  maxBufferedBytes = RUNTIME_EVENTS_MAX_BUFFERED_BYTES,
  stallMs = RUNTIME_EVENTS_STALL_MS,
  now = Date.now,
  request = null,
  includeStream = false,
  maxDeferredTaskWakes = RUNTIME_EVENTS_MAX_DEFERRED_TASK_WAKES,
  maxDeferredTaskWakeBytes = RUNTIME_EVENTS_MAX_DEFERRED_TASK_WAKE_BYTES,
} = {}) {
  let unsubscribe = () => {};
  let heartbeat;
  let closed = false;
  let undrainedSince = null;
  /** `${event}:${taskId}` → frame, kept while undrained so the newest wake per task survives. */
  const deferredTaskWakes = new Map();
  let deferredTaskWakeBytes = 0;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    deferredTaskWakes.clear();
    deferredTaskWakeBytes = 0;
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
  const flushDeferredTaskWakes = () => {
    if (deferredTaskWakes.size === 0 || closed) return;
    const chunk = [...deferredTaskWakes.values()].map(({ frame }) => frame).join("");
    deferredTaskWakes.clear();
    deferredTaskWakeBytes = 0;
    write(chunk);
  };
  response.on("drain", () => {
    undrainedSince = null;
    flushDeferredTaskWakes();
  });
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
      if (closed) return;
      if (event === "task_stream" && !includeStream) return;
      if (!["snapshot", "routine", "task_dirty", "task_stream"].includes(event)) return;
      const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      if (TASK_WAKE_EVENTS.has(event) && undrainedSince !== null) {
        const taskId = typeof payload?.taskId === "string" ? payload.taskId : "";
        const key = `${event}:${taskId}`;
        const bytes = Buffer.byteLength(frame);
        const previous = deferredTaskWakes.get(key);
        if (previous) {
          deferredTaskWakes.delete(key);
          deferredTaskWakeBytes -= previous.bytes;
        }
        if (
          bytes <= maxDeferredTaskWakeBytes
          && deferredTaskWakes.size < maxDeferredTaskWakes
          && deferredTaskWakeBytes + bytes <= maxDeferredTaskWakeBytes
        ) {
          deferredTaskWakes.set(key, { frame, bytes });
          deferredTaskWakeBytes += bytes;
        }
        return;
      }
      write(frame);
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
