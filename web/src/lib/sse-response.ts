import { constants, createGzip } from "node:zlib";

/**
 * SSE responses compressed per event.
 *
 * Next's built-in compression skips `no-transform` responses, so every SSE byte (full task snapshots
 * included) crossed the network raw. Remote clients (Tailscale, mobile) pay for that on every wake.
 * One gzip context lives for the whole connection and is sync-flushed after every chunk the route
 * enqueues, so each event is delivered immediately while repeated JSON keys and recently sent rows
 * still compress against the shared window.
 */

/** zlib level 4: most of level 6's ratio on JSON at a fraction of the CPU per wake. */
const SSE_GZIP_LEVEL = 4;

export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-cache, no-transform",
  Connection: "keep-alive",
};

/** True when the request accepts gzip (q=0 excluded). */
export function acceptsGzip(acceptEncoding: string | null | undefined): boolean {
  if (!acceptEncoding) return false;
  for (const entry of acceptEncoding.split(",")) {
    const [name, ...params] = entry.trim().toLowerCase().split(";");
    if (name !== "gzip" && name !== "*") continue;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue;
    return true;
  }
  return false;
}

/**
 * Gzip a push-style SSE body, flushing after every upstream chunk. Cancelling the result cancels the
 * upstream body, so the route's cleanup (subscriptions, polls, heartbeat) still runs on disconnect.
 */
export function gzipSseStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const gzip = createGzip({ level: SSE_GZIP_LEVEL });
  let finished = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      gzip.on("data", (chunk: Buffer) => {
        if (finished) return;
        try {
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        } catch {
          /* the consumer went away; cancel() tears the rest down */
        }
      });
      gzip.on("end", () => {
        if (finished) return;
        finished = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      gzip.on("error", () => {
        if (finished) return;
        finished = true;
        reader.cancel().catch(() => {});
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      void (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done || finished) break;
            gzip.write(chunk.value);
            // Sync flush ends the deflate block so the browser can decode this event now.
            await new Promise<void>((resolve) => gzip.flush(constants.Z_SYNC_FLUSH, () => resolve()));
          }
        } catch {
          /* upstream errored: end the compressed stream cleanly so EventSource reconnects */
        }
        if (!finished) gzip.end();
      })();
    },
    cancel(reason) {
      finished = true;
      gzip.destroy();
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/** Build an SSE response, gzip-encoded when the client accepts it. */
export function sseResponse(
  acceptEncoding: string | null | undefined,
  body: ReadableStream<Uint8Array>,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = { ...SSE_RESPONSE_HEADERS, ...extraHeaders, Vary: "Accept-Encoding" };
  if (!acceptsGzip(acceptEncoding)) return new Response(body, { headers });
  return new Response(gzipSseStream(body), { headers: { ...headers, "Content-Encoding": "gzip" } });
}
