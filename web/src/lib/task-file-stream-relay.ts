import { randomUUID } from "node:crypto";
import { isCrossOriginRequest } from "@/lib/same-origin";
import { TTS_AUDIO_ROUTE, TTS_AUDIO_BODY_LIMIT, TTS_AUDIO_OPERATION_HEADER, TTS_AUDIO_EXECUTION_HEADER, TTS_AUDIO_HEADER_TIMEOUT_MS } from "@shared/tts-audio-contract.mjs";
import { TASK_FILE_STREAM_PATH, TASK_FILE_ROUTES, FILE_STREAM_HEADERS, taskFileTarget } from "@shared/task-file-stream-contract.mjs";
import { JSON_BUSINESS_HEADERS } from "@shared/json-business-contract.mjs";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "@shared/backend-protocol.mjs";
import { backendBaseUrl, expectedBackendGeneration, isBackendGenerationCompatible, readBackendHealth } from "@/lib/backend-client";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "@/lib/webui-auth";
const failure = (status: number, execution?: "not-started" | "unknown") => Response.json({ error: "Backendのファイル配信を利用できません", ...(execution ? { execution } : {}) }, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
/** Next normalizes loopback URLs/bind hosts; Host retains the browser's authority. */
function fileStreamRequestUrl(request: Request): URL | null {
  const url = new URL(request.url), host = request.headers.get("host");
  if (host === null) return url;
  if (!host || host.length > 512 || /[\s\\/@?#,]/.test(host)) return null;
  try {
    const authority = new URL(`${url.protocol}//${host}/`);
    if (!authority.hostname || authority.username || authority.password) return null;
    url.host = authority.host; return url;
  } catch { return null; }
}
/** Transport only: opaque path query, no filesystem/SDK/business input parsing and no response buffering. */
export async function relayTaskFileStream(request: Request, route: string): Promise<Response> {
  const isTts = route === TTS_AUDIO_ROUTE; let handedOff = false;
  const fail = (status: number) => failure(status, isTts ? handedOff ? "unknown" : "not-started" : undefined);
  const target = taskFileTarget(route);
  if (!target) return fail(404);
  if (!TASK_FILE_ROUTES[target.route].includes(request.method)) return fail(405);
  const authorized = isWebUiRequestAuthorized(request);
  if (webUiAuthRequired() && !authorized) return fail(401);
  const token = process.env.LEAFCODE_PI_BACKEND_TOKEN?.trim(); if (!token) return fail(503);
  const expected = expectedBackendGeneration();
  if (expected) { const health = await readBackendHealth(); if (!health.ok || !isBackendGenerationCompatible(expected, health.body.runtimeGeneration)) return fail(503); }
  if (request.signal.aborted) return fail(400);
  const original = fileStreamRequestUrl(request); if (!original) return fail(400);
  if (isTts && isCrossOriginRequest({ headers: request.headers, nextUrl: original })) return fail(403);
  let body: Uint8Array | undefined;
  if (isTts) {
    if (Number(request.headers.get("content-length")) > TTS_AUDIO_BODY_LIMIT) return fail(413);
    const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    let rejectStopped: (error: Error) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
    const stop = () => { rejectStopped(new Error("Request body closed")); void reader?.cancel().catch(() => {}); };
    const deadline = setTimeout(stop, 2000); deadline.unref?.(); request.signal.addEventListener("abort", stop, { once: true });
    try { if (request.signal.aborted) stop(); if (reader) for (;;) { const part = await Promise.race([reader.read(), stopped]); if (part.done) break; size += part.value.length; if (size > TTS_AUDIO_BODY_LIMIT) { await reader.cancel(); return fail(413); } chunks.push(part.value); } body = new Uint8Array(size); let at = 0; for (const bytes of chunks) { body.set(bytes, at); at += bytes.length; } }
    catch { return fail(400); } finally { clearTimeout(deadline); request.signal.removeEventListener("abort", stop); reader?.releaseLock(); }
  }
  if (request.signal.aborted) return fail(400);
  const operationId = isTts ? randomUUID() : undefined;
  const controller = new AbortController(), abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, isTts ? TTS_AUDIO_HEADER_TIMEOUT_MS : 10_000); timer.unref?.();
  const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener("abort", abort); controller.abort(); };
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION), [JSON_BUSINESS_HEADERS.origin]: original.origin, [JSON_BUSINESS_HEADERS.host]: request.headers.get("host") ?? original.host, [JSON_BUSINESS_HEADERS.authorized]: authorized ? "1" : "0", "accept-encoding": "identity" };
    for (const name of ["range", "if-range", "origin", "content-type"]) { const value = request.headers.get(name); if (value !== null) headers[name] = value; }
    if (operationId) headers[JSON_BUSINESS_HEADERS.operation] = operationId;
    handedOff = true;
    const source = await fetch(`${backendBaseUrl()}${TASK_FILE_STREAM_PATH}/${route}${original.search}`, { method: request.method, headers, ...(body ? { body: new Uint8Array(body).slice().buffer } : {}), signal: controller.signal, redirect: "error", cache: "no-store" });
    clearTimeout(timer);
    if (source.headers.get(BACKEND_PROTOCOL_HEADER) !== String(BACKEND_PROTOCOL_VERSION) || source.headers.has("content-encoding") || source.status < 200 || source.status >= 500 && source.status !== 503 && !isTts) {
      await source.body?.cancel().catch(() => {}); cleanup(); return fail(503);
    }
    if (isTts && source.ok && (source.status !== 200 || source.headers.get(TTS_AUDIO_OPERATION_HEADER) !== operationId || source.headers.get(TTS_AUDIO_EXECUTION_HEADER) !== "unknown" || !/^(?:audio\/[A-Za-z0-9.+-]+|application\/octet-stream)$/.test(source.headers.get("content-type") ?? ""))) { await source.body?.cancel().catch(() => {}); cleanup(); return fail(503); }
    const outputHeaders = new Headers();
    for (const name of FILE_STREAM_HEADERS) { const value = source.headers.get(name); if (value !== null) outputHeaders.set(name, value); }
    if (request.method === "HEAD" || !source.body) { await source.body?.cancel().catch(() => {}); cleanup(); return new Response(null, { status: source.status, headers: outputHeaders }); }
    const reader = source.body.getReader();
    const responseBody = new ReadableStream<Uint8Array>({
      async pull(output) {
        try { const { done, value } = await reader.read(); if (done) { cleanup(); reader.releaseLock(); output.close(); } else output.enqueue(value); }
        catch { cleanup(); try { reader.releaseLock(); } catch { /* Cancellation can overlap a pull. */ } output.error(new Error("File transport closed")); }
      },
      async cancel() { cleanup(); await reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Already released by a failed pull. */ } },
    }, { highWaterMark: 0 });
    return new Response(responseBody, { status: source.status, headers: outputHeaders });
  } catch { cleanup(); return fail(503); }
}
