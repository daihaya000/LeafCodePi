import { Agent, fetch as undiciFetch } from "@/lib/gateway-http.mjs";
const liveEventsDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 10000, connect: { timeout: 10000 }, connections: 32 });
import { LIVE_EVENT_PATH, LIVE_EVENT_HEADERS, liveEventTarget } from "@shared/live-event-contract.mjs";
import { JSON_BUSINESS_HEADERS } from "@shared/json-business-contract.mjs";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "@shared/backend-protocol.mjs";
import { backendBaseUrl, expectedBackendGeneration, isBackendGenerationCompatible, readBackendHealth } from "@/lib/backend-client";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "@/lib/webui-auth";
const fail = (status: number) => Response.json({ error: "Backendのイベント配信を利用できません" }, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
/** Transport only: opaque path query, no filesystem/SDK/business input parsing and no response buffering. */
export async function relayLiveEvents(request: Request, route: string): Promise<Response> {
  const target = liveEventTarget(route);
  if (!target) return fail(404);
  if (request.method !== "GET") return fail(405);
  const authorized = isWebUiRequestAuthorized(request);
  if (webUiAuthRequired() && !authorized) return fail(401);
  const token = process.env.LEAFCODE_PI_BACKEND_TOKEN?.trim(); if (!token) return fail(503);
  if (request.signal.aborted) return fail(400);
  const expected = expectedBackendGeneration();
  if (expected) { const health = await readBackendHealth(); if (!health.ok || !isBackendGenerationCompatible(expected, health.body.runtimeGeneration)) return fail(503); }
  const original = new URL(request.url), controller = new AbortController(), abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 10_000); timer.unref?.();
  const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener("abort", abort); controller.abort(); };
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION), [JSON_BUSINESS_HEADERS.origin]: original.origin, [JSON_BUSINESS_HEADERS.host]: request.headers.get("host") ?? original.host, [JSON_BUSINESS_HEADERS.authorized]: authorized ? "1" : "0", "accept-encoding": "identity" };
    for (const name of ["last-event-id"]) { const value = request.headers.get(name); if (value !== null) headers[name] = value; }
    const source = await (undiciFetch as unknown as typeof fetch)(`${backendBaseUrl()}${LIVE_EVENT_PATH}/${route}${original.search}`, { method: request.method, headers, signal: controller.signal, redirect: "error", cache: "no-store", dispatcher: liveEventsDispatcher } as RequestInit);
    clearTimeout(timer);
    if (source.headers.get(BACKEND_PROTOCOL_HEADER) !== String(BACKEND_PROTOCOL_VERSION) || source.headers.has("content-encoding") || source.status < 200 || source.status >= 500 && source.status !== 503 || source.status === 200 && (!source.body || !source.headers.get("content-type")?.startsWith("text/event-stream"))) {
      await source.body?.cancel().catch(() => {}); cleanup(); return fail(503);
    }
    const outputHeaders = new Headers();
    for (const name of LIVE_EVENT_HEADERS) { const value = source.headers.get(name); if (value !== null) outputHeaders.set(name, value); }
    if (!source.body) { cleanup(); return new Response(null, { status: source.status, headers: outputHeaders }); }
    const reader = source.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(output) {
        try { const { done, value } = await reader.read(); if (done) { cleanup(); reader.releaseLock(); output.close(); } else output.enqueue(value); }
        catch { cleanup(); try { reader.releaseLock(); } catch { /* Cancellation can overlap a pull. */ } output.close(); }
      },
      async cancel() { cleanup(); await reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Already released by a failed pull. */ } },
    }, { highWaterMark: 0 });
    return new Response(body, { status: source.status, headers: outputHeaders });
  } catch { cleanup(); return fail(503); }
}
