/**
 * OpenRouter usage via GET https://openrouter.ai/api/v1/key.
 * Credits-only (pay-as-you-go); no rate windows.
 */

import {
  ProviderError,
  type IUsageProvider,
  type UsageScope,
  type UsageSnapshot,
} from "@/lib/codexbar/types";
import {
  asRecord,
  cleanApiKey,
  fetchText,
  flexibleNumber,
} from "@/lib/codexbar/utils";
import { readPiApiKey } from "@/lib/codexbar/pi-auth";

const KEY_API_URL = "https://openrouter.ai/api/v1/key";

const DEFAULT_SCOPE: UsageScope = {
  key: "default",
  kind: "default",
  accountId: null,
  accountLabel: null,
  authPath: null,
};

/**
 * API キーの解決順: アカウント（または既定）の auth.json → 環境変数。
 * アカウントスコープでは env へフォールバックしない（全アカウントが同じ残量を
 * 表示してしまい、統合ルーティングの判断材料が壊れる）。
 */
export function resolveOpenRouterApiKey(scope: UsageScope = DEFAULT_SCOPE): string | null {
  const stored = cleanApiKey(
    readPiApiKey("openrouter", scope.authPath ? { authPath: scope.authPath } : undefined),
  );
  if (stored) return stored;
  if (scope.kind === "account") return null;
  return cleanApiKey(process.env.OPENROUTER_API_KEY);
}

/** Exported for unit tests. */
export function parseOpenRouterKeyJson(json: string): UsageSnapshot {
  const root = asRecord(JSON.parse(json));
  const data = asRecord(root?.data);
  if (!data) throw new ProviderError("OpenRouter の応答形式が不正です。");

  const usage = flexibleNumber(data.usage) ?? 0;
  const limit = flexibleNumber(data.limit);
  const limitRemaining = flexibleNumber(data.limit_remaining);
  const isFreeTier = data.is_free_tier === true;

  let balance: number | null = null;
  if (limit !== null) {
    balance =
      limitRemaining !== null
        ? Math.min(Math.max(limitRemaining, 0), limit)
        : Math.max(0, limit - usage);
  }

  return {
    providerId: "openrouter",
    providerName: "OpenRouter",
    plan: isFreeTier ? "Free" : "Pay-as-you-go",
    accountEmail: null,
    windows: [],
    creditsEnabled: true,
    creditsTitle: "利用額",
    creditsUsed: usage,
    creditsLimit: limit !== null && limit > 0 ? limit : null,
    creditsBalance: balance,
    creditsLabel: null,
    sourceLabel: "openrouter.ai/api/v1/key",
    updatedAt: new Date(),
    isStale: false,
  };
}

export function createOpenRouterProvider(scope: UsageScope): IUsageProvider {
  return {
    id: "openrouter",
    name: "OpenRouter",
    isConfigured() {
      return resolveOpenRouterApiKey(scope) !== null;
    },
    async fetch(signal) {
      const apiKey = resolveOpenRouterApiKey(scope);
      if (!apiKey) throw new ProviderError("API キーが未設定です");

      const { status, body, ok } = await fetchText(KEY_API_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal,
      });
      if (status === 401 || status === 403) {
        throw new ProviderError("API キーが無効です");
      }
      if (!ok) {
        const snippet = body.length > 200 ? body.slice(0, 200) : body;
        throw new ProviderError(
          `OpenRouter API エラー HTTP ${status}: ${snippet}`,
        );
      }
      try {
        return parseOpenRouterKeyJson(body);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError("OpenRouter の応答を解析できませんでした。", {
          cause: err,
        });
      }
    },
  };
}

export const openrouterProvider: IUsageProvider = createOpenRouterProvider(DEFAULT_SCOPE);
