import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";

/** Bounded SSE transport for the owner's process-local Bot/routine buses. */
export function streamRuntimeEvents(response, subscribe) {
  let unsubscribe = () => {};
  let heartbeat;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { unsubscribe(); } catch { /* Disconnect must never crash the runtime owner. */ }
  };
  response.once("close", cleanup);
  response.once("error", cleanup);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-cache, no-transform",
    [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
  });
  response.flushHeaders();
  try {
    unsubscribe = subscribe(({ event, payload }) => {
      if (closed || !["snapshot", "routine", "task_dirty"].includes(event)) return;
      // Drop a stalled transport rather than buffer unbounded events. EventSource reconnects.
      try {
        if (!response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)) response.destroy();
      } catch { response.destroy(); }
    });
    if (closed) { unsubscribe(); return; }
    response.write(": connected\n\n");
    heartbeat = setInterval(() => {
      if (!closed && !response.write(": heartbeat\n\n")) response.destroy();
    }, 15_000);
    heartbeat.unref?.();
  } catch { response.destroy(); cleanup(); }
}
