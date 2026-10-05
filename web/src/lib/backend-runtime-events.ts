import { Agent } from "undici";
import { backendBaseUrl, type BackendEnv } from "@/lib/backend-client";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION, BACKEND_RUNTIME_EVENTS_PATH } from "@shared/backend-protocol.mjs";

/**
 * Long-lived Backend SSE. undici's default bodyTimeout (300s between chunks) kills a quiet
 * stream and storms reconnects against a recovering Backend — disable it; heartbeats still
 * prove liveness, and the connect/headers deadline below covers the handshake only.
 */
export const runtimeEventsDispatcher = new Agent({
  bodyTimeout: 0,
  headersTimeout: 60_000,
  connect: { timeout: 10_000 },
});

/**
 * Re-expose the upstream body so a Backend disconnect (restart, dropped transport) ends the
 * browser stream cleanly. Piping the raw body made Next log "failed to pipe response" for every
 * `terminated` socket; a clean end lets EventSource reconnect on its own.
 */
export function endOnUpstreamError(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        reader.cancel().catch(() => {});
        chunk = { done: true, value: undefined };
      }
      if (cancelled) return;
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/** Proxy only the event body; internal credentials and headers never reach the browser. */
export async function forwardRuntimeEventStream(signal: AbortSignal, { env = process.env, fetchImpl = fetch, timeoutMs = 10_000, dispatcher = runtimeEventsDispatcher }: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number; dispatcher?: Agent } = {}): Promise<Response> {
  const failed = () => Response.json({ error: "Backendのイベントを取得できません" }, { status: 503 });
  const token = env.LEAFCODE_PI_BACKEND_TOKEN?.trim();
  if (!token) return failed();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${backendBaseUrl(env)}${BACKEND_RUNTIME_EVENTS_PATH}`, {
      headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) },
      signal: AbortSignal.any([signal, deadline.signal]), cache: "no-store",
      // undici-specific; Node's fetch and Next's undici both honor it. Test doubles ignore it.
      dispatcher,
    } as RequestInit);
    if (!response.ok || !response.body || response.headers.get(BACKEND_PROTOCOL_HEADER) !== String(BACKEND_PROTOCOL_VERSION)
      || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await response.body?.cancel();
      return failed();
    }
    return new Response(endOnUpstreamError(response.body), { headers: {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-cache, no-transform", Connection: "keep-alive",
    } });
  } catch { return failed(); }
  finally { clearTimeout(timer); }
}
