import { Agent, fetch as undiciFetch } from "@/lib/gateway-http.mjs";
const dispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 10000, connect: { timeout: 10000 }, connections: 32 });
import { PROVIDER_AUTH_EVENTS_PATH } from "@shared/provider-auth-contract.mjs";
import { JSON_BUSINESS_HEADERS } from "@shared/json-business-contract.mjs";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "@shared/backend-protocol.mjs";
import { backendBaseUrl, expectedBackendGeneration, isBackendGenerationCompatible, readBackendHealth } from "@/lib/backend-client";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "@/lib/webui-auth";
const fail = (status: number) => Response.json({ error: "Backendのログインイベントを利用できません" }, { status, headers: { "cache-control": "no-store, private" } });
/** Opaque SSE ingress: no session lookup, SDK subscription, event interpretation or fallback in Next. */
export async function relayProviderLoginEvents(request: Request, encodedId: string): Promise<Response> {
  if (request.method !== "GET") return fail(405);
  const authorized = isWebUiRequestAuthorized(request);
  if (webUiAuthRequired() && !authorized) return fail(401);
  const token = process.env.LEAFCODE_PI_BACKEND_TOKEN?.trim(); if (!token) return fail(503);
  const expected = expectedBackendGeneration();
  if (expected) { const health = await readBackendHealth(); if (!health.ok || !isBackendGenerationCompatible(expected, health.body.runtimeGeneration)) return fail(503); }
  if (request.signal.aborted) return fail(400);
  const original = new URL(request.url), controller = new AbortController(), abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 10_000); timeout.unref?.();
  const cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener("abort", abort); controller.abort(); };
  try {
    const source = await (undiciFetch as unknown as typeof fetch)(`${backendBaseUrl()}${PROVIDER_AUTH_EVENTS_PATH}/${encodedId}${original.search}`, {
      headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
        [JSON_BUSINESS_HEADERS.origin]: original.origin, [JSON_BUSINESS_HEADERS.host]: request.headers.get("host") ?? original.host,
        [JSON_BUSINESS_HEADERS.authorized]: authorized ? "1" : "0", "accept-encoding": "identity" }, signal: controller.signal,
      redirect: "error", cache: "no-store", dispatcher,
    } as RequestInit);
    clearTimeout(timeout);
    if (source.headers.get(BACKEND_PROTOCOL_HEADER) !== String(BACKEND_PROTOCOL_VERSION) || source.headers.has("content-encoding") || source.status !== 200 || !source.body || !source.headers.get("content-type")?.startsWith("text/event-stream")) { await source.body?.cancel().catch(() => {}); cleanup(); return fail(source.status >= 400 ? source.status : 503); }
    const reader = source.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try { const { value, done } = await reader.read(); if (done) { cleanup(); reader.releaseLock(); output.close(); } else output.enqueue(value); }
        catch { cleanup(); await reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Concurrent cancel. */ } output.error(new Error("Login event transport closed")); }
      },
      async cancel() { cleanup(); await reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Concurrent pull. */ } },
    }, { highWaterMark: 0 });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "private, no-store, no-cache, no-transform", "x-content-type-options": "nosniff" } });
  } catch { cleanup(); return fail(503); }
}
