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
 */
export function streamRuntimeEvents(response, subscribe, {
  heartbeatMs = 15_000,
  maxBufferedBytes = RUNTIME_EVENTS_MAX_BUFFERED_BYTES,
  stallMs = RUNTIME_EVENTS_STALL_MS,
  now = Date.now,
} = {}) {
  let unsubscribe = () => {};
  let heartbeat;
  let closed = false;
  let undrainedSince = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { unsubscribe(); } catch { /* Disconnect must never crash the runtime owner. */ }
  };
  const drop = () => { cleanup(); response.destroy(); };
  const write = (chunk) => {
    if (closed) return;
    try {
      if (!response.write(chunk)) undrainedSince ??= now();
      if (response.writableLength > maxBufferedBytes) drop();
    } catch { drop(); }
  };
  response.once("close", cleanup);
  response.once("error", cleanup);
  response.on("drain", () => { undrainedSince = null; });
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
    write(": connected\n\n");
    heartbeat = setInterval(() => {
      if (closed) return;
      // A consumer that has not drained for stallMs is gone; EventSource reconnects.
      if (undrainedSince !== null && now() - undrainedSince >= stallMs) { drop(); return; }
      write(": heartbeat\n\n");
    }, heartbeatMs);
    heartbeat.unref?.();
  } catch { drop(); }
}
