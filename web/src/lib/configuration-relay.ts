import { randomUUID } from "node:crypto";
import { isCrossOriginRequest } from "@/lib/same-origin";
import { backendBaseUrl, expectedBackendGeneration, isBackendGenerationCompatible, readBackendHealth } from "@/lib/backend-client";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "@/lib/webui-auth";
import { CONFIGURATION_PATH, CONFIGURATION_HEADERS, configurationTarget, configurationBodyLimit, publicConfigurationMutation } from "@shared/configuration-contract.mjs";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "@shared/backend-protocol.mjs";

const noStore = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };
function error(status: number, message: string, mutation?: object) {
  return Response.json({ error: message, ...(mutation ? { mutation } : {}) }, { status, headers: noStore });
}
async function boundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length")) > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
/** Ingress only. No settings helper, SDK instance, local persistence or retry fallback. */
export async function relayConfiguration(request: Request, route: string): Promise<Response> {
  const target = configurationTarget(route);
  if (!target) return error(400, "設定の経路が不正です");
  const authorized = isWebUiRequestAuthorized(request);
  const original = new URL(request.url);
  if (webUiAuthRequired() && !authorized) return error(401, "認証が必要です");
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && isCrossOriginRequest({ headers: request.headers, nextUrl: original })) return error(403, "許可されない接続元です");
  const sensitive = ["notifications", "pushover", "settings/transfer", "profile"].includes(target.route);
  if (sensitive) {
    const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"];
    let headerHost = "";
    try { headerHost = new URL(`http://${request.headers.get("host") ?? original.host}`).hostname; } catch { /* fail closed */ }
    const localTransfer = loopback.includes(process.env.LEAFCODE_PI_BIND_HOST ?? "") && loopback.includes(original.hostname) && loopback.includes(headerHost);
    if (!authorized && !localTransfer) return error(403, "WebUIアクセスゲートが必要です");
    if (origin && origin !== original.origin) return error(403, "許可されない接続元です");
  }
  const operationId = randomUUID();
  const before = { operationId, saved: false, saveStatus: "none", revision: null, apply: "not-required", recovery: "none" };
  const unknown = { operationId, saved: null, saveStatus: "unknown", revision: null, apply: "unknown", recovery: "unknown" };
  const mutation = request.method !== "GET";
  const token = process.env.LEAFCODE_PI_BACKEND_TOKEN?.trim();
  if (!token) return error(503, "Backendを利用できません", mutation ? before : undefined);
  const expected = expectedBackendGeneration();
  if (expected) {
    const health = await readBackendHealth();
    if (!health.ok || !isBackendGenerationCompatible(expected, health.body.runtimeGeneration)) return error(503, "Backendの世代が一致しません", mutation ? before : undefined);
  }
  let body: Uint8Array | undefined;
  if (mutation) {
    try {
      const buffered = await boundedBody(request, configurationBodyLimit(target.route, request.method));
      if (buffered === null) return error(413, "設定ファイルが大きすぎます", before);
      body = buffered;
    } catch { return error(400, "本文を読み込めません", before); }
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
    [CONFIGURATION_HEADERS.origin]: original.origin, [CONFIGURATION_HEADERS.host]: request.headers.get("host") ?? original.host,
    [CONFIGURATION_HEADERS.authorized]: authorized ? "1" : "0", [CONFIGURATION_HEADERS.operation]: operationId,
  };
  for (const key of ["content-type", "origin", "sec-fetch-site", "x-forwarded-host"]) { const value = request.headers.get(key); if (value) headers[key] = value; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.route === "profile" ? 150_000 : 30_000);
  timer.unref?.();
  try {
    const response = await fetch(`${backendBaseUrl()}${CONFIGURATION_PATH}/${route}${original.search}`, {
      method: request.method, headers, ...(body?.byteLength ? { body: new Uint8Array(body).slice().buffer } : {}), signal: controller.signal,
    });
    const result = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) return error(503, "Backendの応答が不正です", mutation ? unknown : undefined);
    if (mutation) {
      const state = publicConfigurationMutation(result.mutation);
      if (!state || state.operationId !== operationId) {
        // These admission failures occur before owner execution. Other missing outcomes are unknown, never retried.
        const refused = [401, 403, 404, 405, 409, 413].includes(response.status) || result.code === "BACKEND_RUNTIME_UNAVAILABLE";
        return error(response.status >= 400 ? response.status : 503, "Backendが設定を処理できません", refused ? before : unknown);
      }
      result.mutation = state;
    }
    return Response.json(result, { status: response.status, headers: noStore });
  } catch { return error(503, "Backendの応答を確認できません", mutation ? unknown : undefined); }
  finally { clearTimeout(timer); }
}
