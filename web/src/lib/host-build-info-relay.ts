import { randomUUID } from "node:crypto";
import { resolveHostControlUrl } from "./host-http-client";
import { isCrossOriginRequest } from "./same-origin";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "./webui-auth";
import { HOST_BUILD_INFO_PATH, HOST_BUILD_INFO_HEADER, HOST_BUILD_OPERATION_HEADER, HOST_BUILD_INFO_BODY_LIMIT, publicHostBuildInfo } from "@shared/host-build-info-contract.mjs";
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
async function boundedBody(source: Request | Response, max: number) {
  if (Number(source.headers.get("content-length")) > max) { await source.body?.cancel().catch(() => {}); return null; }
  if (!source.body) return new Uint8Array();
  const reader = source.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > max) { await reader.cancel(); return null; } parts.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; } return bytes;
}
/** Browser ingress/opaque HTTP only. Host owns Git, the repo and durable admission. */
export async function relayHostBuildInfo(request: Request): Promise<Response> {
  const mutation = request.method === "POST"; let handedOff = false;
  const fail = (status: number) => Response.json({ error: "HostのGit情報・更新処理を確認できません",
    ...(mutation ? { execution: handedOff ? "unknown" : "not-started" } : {}) }, { status, headers });
  if (!["GET", "POST"].includes(request.method)) return fail(405);
  if (webUiAuthRequired() && !isWebUiRequestAuthorized(request)) return fail(401);
  if (mutation && isCrossOriginRequest({ headers: request.headers, nextUrl: new URL(request.url) })) return fail(403);
  let body: Uint8Array | undefined;
  try { if (mutation) { const bytes = await boundedBody(request, HOST_BUILD_INFO_BODY_LIMIT); if (bytes === null) return fail(413); body = bytes; } }
  catch { return fail(400); }
  if (request.signal.aborted) return fail(400);
  const id = mutation ? randomUUID() : undefined, controller = new AbortController(), abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, mutation ? 180000 : 15000); timer.unref?.();
  try {
    const url = resolveHostControlUrl() + HOST_BUILD_INFO_PATH;
    handedOff = mutation;
    const response = await fetch(url, {
      method: request.method, cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { [HOST_BUILD_INFO_HEADER]: "1", ...(id ? { [HOST_BUILD_OPERATION_HEADER]: id } : {}) },
      ...(body?.length ? { body: body.slice().buffer } : {}),
    });
    const bytes = await boundedBody(response, 4096); if (bytes === null) return fail(503);
    if ([404, 501].includes(response.status)) { handedOff = false; return fail(501); }
    const projected = publicHostBuildInfo(JSON.parse(new TextDecoder().decode(bytes)), response.status);
    if (!projected || mutation && (projected.operation?.id !== id)) {
      if ([400, 401, 403, 405, 413].includes(response.status)) { handedOff = false; return fail(response.status); }
      return fail(503);
    }
    return Response.json(projected, { status: response.status, headers });
  } catch { return fail(503); }
  finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); controller.abort(); }
}
