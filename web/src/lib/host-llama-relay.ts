import { randomUUID } from "node:crypto";
import { resolveHostControlUrl } from "./host-http-client";
import { isCrossOriginRequest } from "./same-origin";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "./webui-auth";
import { HOST_LLAMA_PATH, HOST_LLAMA_HEADER, HOST_LLAMA_OPERATION_HEADER, HOST_LLAMA_BODY_LIMIT, HOST_LLAMA_RESPONSE_LIMIT, HOST_LLAMA_ROUTES, publicHostLlamaBody } from "@shared/host-llama-contract.mjs";
const noStore = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
async function bytes(source: Request | Response, limit: number, signal: AbortSignal) {
  if (Number(source.headers.get("content-length")) > limit) { void source.body?.cancel().catch(() => {}); return null; }
  if (!source.body) return new Uint8Array();
  const reader = source.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  let cancel = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { cancel = () => { reject(new Error("Aborted")); void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", cancel, { once: true }); });
  try {
    if (signal.aborted) cancel();
    for (;;) { const { value, done } = await Promise.race([reader.read(), stopped]); if (done) break; size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; } chunks.push(value); }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; } return data;
}
/** Opaque ingress only: Host owns defaults, parsing, scans, lifecycle and loads. */
export async function relayHostLlama(request: Request, action: string): Promise<Response> {
  const mutation = request.method === "POST"; let handedOff = false;
  const fail = (status: number) => Response.json({ error: "Hostのllama-server処理を確認できません", ...(mutation ? { execution: handedOff ? "unknown" : "not-started" } : {}) }, { status, headers: noStore });
  if (!Object.hasOwn(HOST_LLAMA_ROUTES, action) || !HOST_LLAMA_ROUTES[action].includes(request.method)) return fail(405);
  if (webUiAuthRequired() && !isWebUiRequestAuthorized(request)) return fail(401);
  const original = new URL(request.url);
  if (mutation && isCrossOriginRequest({ headers: request.headers, nextUrl: original })) return fail(403);
  const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, mutation ? 65000 : 10000); timer.unref?.();
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal.aborted) return fail(400);
    const body = mutation ? await bytes(request, HOST_LLAMA_BODY_LIMIT, AbortSignal.any([controller.signal, AbortSignal.timeout(2000)])) : undefined;
    if (body === null) return fail(413);
    if (controller.signal.aborted) return fail(400);
    const url = resolveHostControlUrl() + HOST_LLAMA_PATH + "/" + action + (action === "models" ? original.search : "");
    const id = mutation ? randomUUID() : undefined;
    handedOff = mutation;
    const response = await fetch(url, { method: request.method, cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { [HOST_LLAMA_HEADER]: "1", ...(id ? { [HOST_LLAMA_OPERATION_HEADER]: id } : {}) }, ...(body?.length ? { body: body.slice().buffer } : {}) });
    const data = await bytes(response, HOST_LLAMA_RESPONSE_LIMIT, controller.signal); if (data === null) return fail(503);
    if ([404, 501].includes(response.status)) { handedOff = false; return fail(501); }
    const projected = publicHostLlamaBody(action, JSON.parse(new TextDecoder().decode(data)), response.status);
    if (!projected) return fail(503);
    if (mutation && (projected.operation as { id?: string } | undefined)?.id !== id) {
      if ([400, 401, 403, 405, 413].includes(response.status)) { handedOff = false; return fail(response.status); } return fail(503);
    }
    return Response.json(projected, { status: response.status, headers: noStore });
  } catch { return fail(handedOff ? 503 : 400); }
  finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); controller.abort(); }
}
