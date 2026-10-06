import { Agent, fetch as undiciFetch } from "undici";
import { backendBaseUrl, type BackendEnv } from "@/lib/backend-client";
import { sseResponse } from "@/lib/sse-response";
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
 * The fetch that can use {@link runtimeEventsDispatcher}. Node's built-in fetch bundles its own undici
 * and rejects an Agent from the `undici` package ("invalid onRequestStart method"), so every
 * runtime-event connection failed: the browser hub got 503 and reconnected every 15s, and the
 * server-side dirty hub never attached, leaving cutover task streams on their slow safety-net polls.
 */
export const runtimeEventsFetch = undiciFetch as unknown as typeof fetch;

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
export async function forwardRuntimeEventStream(signal: AbortSignal, { env = process.env, fetchImpl = runtimeEventsFetch, timeoutMs = 10_000, dispatcher = runtimeEventsDispatcher, acceptEncoding }: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number; dispatcher?: Agent; /** Browser Accept-Encoding: gzip the forwarded events for remote clients. */ acceptEncoding?: string | null } = {}): Promise<Response> {
  const failed = () => Response.json({ error: "Backendのイベントを取得できません" }, { status: 503 });
  const token = env.LEAFCODE_PI_BACKEND_TOKEN?.trim();
  if (!token) return failed();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${backendBaseUrl(env)}${BACKEND_RUNTIME_EVENTS_PATH}`, {
      headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) },
      signal: AbortSignal.any([signal, deadline.signal]), cache: "no-store",
      // undici-specific; only the matching undici fetch (runtimeEventsFetch) honors it. Test doubles ignore it.
      dispatcher,
    } as RequestInit);
    if (!response.ok || !response.body || response.headers.get(BACKEND_PROTOCOL_HEADER) !== String(BACKEND_PROTOCOL_VERSION)
      || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await response.body?.cancel();
      return failed();
    }
    return sseResponse(acceptEncoding, endOnUpstreamError(response.body));
  } catch { return failed(); }
  finally { clearTimeout(timer); }
}
