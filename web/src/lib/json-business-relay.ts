import { randomUUID } from "node:crypto";
import { publicConfigurationMutation } from "@shared/configuration-contract.mjs";
import { isCrossOriginRequest } from "@/lib/same-origin";
import { backendBaseUrl, expectedBackendGeneration, isBackendGenerationCompatible, readBackendHealth } from "@/lib/backend-client";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "@/lib/webui-auth";
import { JSON_BUSINESS_PATH, JSON_BUSINESS_ROUTES, JSON_BUSINESS_HEADERS, jsonBusinessTarget, jsonBusinessBodyLimit, JSON_BUSINESS_RESPONSE_LIMIT,
  jsonBusinessTimeout, jsonBusinessMutates, jsonBusinessCommand, publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "@shared/backend-protocol.mjs";

const noStore = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };
function failure(status: number, message: string, execution?: "not-started" | "unknown") {
  return Response.json({ error: message, ...(execution ? { execution } : {}) }, { status, headers: noStore });
}
async function boundedBytes(input: Pick<Request, "body" | "headers">, limit: number) {
  if (Number(input.headers.get("content-length")) > limit) return null;
  if (!input.body) return new Uint8Array();
  const reader = input.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
/** Ingress/transport only: no parsing of business inputs, local execution, fallback or replay. */
export async function relayJsonBusiness(request: Request, route: string): Promise<Response> {
  const target = jsonBusinessTarget(route);
  if (!target) return failure(404, "経路が不正です");
  if (!JSON_BUSINESS_ROUTES[target.route].includes(request.method)) return failure(405, "許可されないメソッドです");
  const mutates = jsonBusinessMutates(route, request.method), before = mutates ? "not-started" : undefined, unknown = mutates ? "unknown" : undefined;
  const authorized = isWebUiRequestAuthorized(request), original = new URL(request.url);
  if (webUiAuthRequired() && !authorized) return failure(401, "認証が必要です", before);
  if (request.method !== "GET" && isCrossOriginRequest({ headers: request.headers, nextUrl: original })) return failure(403, "許可されない接続元です", before);
  if (target.route === "prompts/transfer") {
    const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"];
    let headerHost = ""; try { headerHost = new URL(`http://${request.headers.get("host") ?? original.host}`).hostname; } catch { /* fail closed */ }
    const local = loopback.includes(process.env.LEAFCODE_PI_BIND_HOST ?? "") && loopback.includes(original.hostname) && loopback.includes(headerHost);
    if (!authorized && !local) return failure(403, "WebUIアクセスゲートが必要です", before);
    const origin = request.headers.get("origin");
    if (origin && origin !== original.origin) return failure(403, "許可されない接続元です", before);
  }
  const operationId = jsonBusinessCommand(route, request.method) ? randomUUID() : undefined;
  const token = process.env.LEAFCODE_PI_BACKEND_TOKEN?.trim();
  if (!token) return failure(503, "Backendを利用できません", before);
  const expected = expectedBackendGeneration();
  if (expected) {
    const health = await readBackendHealth();
    if (!health.ok || !isBackendGenerationCompatible(expected, health.body.runtimeGeneration)) return failure(503, "Backendの世代が一致しません", before);
  }
  let body: Uint8Array | undefined;
  if (request.method !== "GET") {
    try {
      const bytes = await boundedBytes(request, jsonBusinessBodyLimit(route));
      if (bytes === null) return failure(413, "本文が大きすぎます", before);
      body = bytes;
    } catch { return failure(400, "本文を読み込めません", before); }
  }
  if (request.signal.aborted) return failure(400, "リクエストが中断されました", before);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
    [JSON_BUSINESS_HEADERS.origin]: original.origin, [JSON_BUSINESS_HEADERS.host]: request.headers.get("host") ?? original.host,
    [JSON_BUSINESS_HEADERS.authorized]: authorized ? "1" : "0", ...(operationId ? { [JSON_BUSINESS_HEADERS.operation]: operationId } : {}) };
  for (const key of ["content-type", "origin", "sec-fetch-site", "x-forwarded-host", "if-none-match"]) {
    const value = request.headers.get(key); if (value) headers[key] = value;
  }
  const controller = new AbortController(), abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, jsonBusinessTimeout(route)); timer.unref?.();
  try {
    const response = await fetch(`${backendBaseUrl()}${JSON_BUSINESS_PATH}/${route}${original.search}`, { method: request.method, headers,
      ...(body?.byteLength ? { body: new Uint8Array(body).slice().buffer } : {}), signal: controller.signal });
    const bytes = await boundedBytes(response, JSON_BUSINESS_RESPONSE_LIMIT);
    if (!bytes) return failure(503, "Backendの応答が大きすぎます", unknown);
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!response.ok) {
      const refused = [401, 403, 404, 405, 409, 413].includes(response.status) || value?.code === "BACKEND_RUNTIME_UNAVAILABLE";
      return failure(response.status >= 400 ? response.status : 503, "Backendが要求を処理できません", refused ? before : unknown);
    }
    const result = publicJsonBusinessResult(route, value);
    if (!result) return failure(503, "Backendの応答が不正です", unknown);
    if (operationId) {
      const mutation = publicConfigurationMutation(result.body?.mutation);
      if (!mutation || mutation.operationId !== operationId) return failure(503, "Backendの操作結果を確認できません", unknown);
    }
    const outputHeaders = new Headers(noStore);
    for (const [key, value] of Object.entries(result.headers)) outputHeaders.set(key, value);
    return result.status === 304 ? new Response(null, { status: 304, headers: outputHeaders })
      : Response.json(result.body, { status: result.status, headers: outputHeaders });
  } catch { return failure(503, "Backendの応答を確認できません。変更処理は自動再実行しません", unknown); }
  finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); }
}
