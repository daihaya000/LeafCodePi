import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { publicTypesafeSettingsBody } from "@shared/typesafe-settings-contract.mjs";
import { hasTypesafeCookieFile, saveTypesafeCookieFile, deleteTypesafeCookieFile } from "./codexbar/browser-cookies";
import { readTypesafeCreditBaseline, writeTypesafeCreditBaseline } from "./codexbar/providers/typesafe";
import { invalidateCachedUsage } from "./codexbar/cache";
import { clearProviderCache } from "./codexbar/provider-cache";
import { jsonError } from "./pi/harness";
const UNKNOWN = "TypeSafe設定の処理結果を確認できません";
/** Only the owner reads default Console credentials or changes billing-display settings/caches. */
export function readTypesafeSettings(cookie: boolean) {
  assertConfigurationOwner();
  const body = cookie ? { configured: hasTypesafeCookieFile() } : { baselineUsd: readTypesafeCreditBaseline() };
  // Validate before JSON.stringify can disguise non-finite numbers as a valid null.
  if (!publicTypesafeSettingsBody(cookie ? "typesafe-cookie" : "typesafe-baseline", body, 200, "GET"))
    throw Object.assign(new Error(UNKNOWN), { status: 503 });
  return body;
}
export function mutateTypesafeSettings(cookie: boolean, method: string, body: unknown): { status: number; body: unknown } {
  assertConfigurationOwner();
  let effectsStarted = false;
  try {
    const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
    if (method !== "POST" && method !== "DELETE") return { status: 405, body: { error: "Method not allowed" } };
    if (cookie) {
      if (method === "POST") {
        if (typeof input?.cookies !== "string") return { status: 400, body: { error: "cookies は文字列で指定してください" } };
        // Validation precedes the common writer's effect boundary; write exceptions are always uncertain.
        saveTypesafeCookieFile(input.cookies);
      } else deleteTypesafeCookieFile();
      effectsStarted = true;
      invalidateCachedUsage();
      clearProviderCache("default:typesafe");
      return { status: 200, body: { ok: true, configured: method === "POST" } };
    }
    const baselineUsd = method === "DELETE" ? null : input?.baselineUsd;
    if (method === "POST" && (typeof baselineUsd !== "number" || !Number.isFinite(baselineUsd) || baselineUsd <= 0 || baselineUsd > 1_000_000))
      return { status: 400, body: { error: "baselineUsd は 0 より大きく 1000000 以下の数値で指定してください" } };
    effectsStarted = true;
    writeTypesafeCreditBaseline(baselineUsd as number | null);
    invalidateCachedUsage();
    clearProviderCache("default:typesafe");
    return { status: 200, body: { ok: true, baselineUsd } };
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return { status: effectsStarted || status >= 500 ? 503 : status, body: { error: effectsStarted || status >= 500 ? UNKNOWN : message } };
  }
}
