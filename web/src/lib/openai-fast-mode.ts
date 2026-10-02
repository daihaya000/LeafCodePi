/**
 * Fast の送信値は Codex 公式クライアントと同じ priority。
 * Codex OAuth の応答 tier=default は Fast 無効を意味しない（APIキー経路とは仕様が異なる）。
 * https://github.com/openai/codex/issues/14204#issuecomment-4033184620
 */
export const OPENAI_FAST_MODE_SETTING_KEY = "openai-fast-mode";

export const OPENAI_FAST_SERVICE_TIER = "priority";

const OPENAI_FAST_PROVIDERS: ReadonlySet<string> = new Set(["openai", "openai-codex"]);

export function isOpenAiFastModeEnabled(value: string | null | undefined): boolean {
  return value === "1";
}

export function supportsOpenAiFastMode(provider: string | null | undefined): boolean {
  return typeof provider === "string" && OPENAI_FAST_PROVIDERS.has(provider);
}

/**
 * 有効かつ対象プロバイダーのとき、service_tier を未指定の payload にだけ付与する。
 * 変更不要なら undefined を返し、Pi には元の payload を使わせる。
 */
export function applyOpenAiFastMode(
  payload: unknown,
  provider: string | null | undefined,
  enabled: boolean,
): unknown {
  if (!enabled || !supportsOpenAiFastMode(provider)) return undefined;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  if ((payload as { service_tier?: unknown }).service_tier !== undefined) return undefined;
  return { ...payload, service_tier: OPENAI_FAST_SERVICE_TIER };
}
