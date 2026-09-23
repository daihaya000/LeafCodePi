/**
 * OpenRouter usage via GET https://openrouter.ai/api/v1/key.
 * Account balance via GET /api/v1/credits (management key required).
 * Key spending limits via /key remain available without a management key.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyCreditBaseline } from "@/lib/codexbar/providers/anthropic";
import {
  ProviderError,
  type IUsageProvider,
  type UsageScope,
  type UsageSnapshot,
} from "@/lib/codexbar/types";
import {
  asRecord,
  atomicWriteText,
  cleanApiKey,
  fetchText,
  flexibleNumber,
} from "@/lib/codexbar/utils";
import { readPiApiKey } from "@/lib/codexbar/pi-auth";

const KEY_API_URL = "https://openrouter.ai/api/v1/key";
const CREDITS_API_URL = "https://openrouter.ai/api/v1/credits";

function accountConfigPath(authPath: string): string {
  return join(dirname(authPath), "openrouter.json");
}

function readAccountConfig(authPath: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(readFileSync(accountConfigPath(authPath), "utf8"))) ?? {};
  } catch {
    return {};
  }
}

export function readOpenRouterManagementKey(authPath: string): string | null {
  const value = readAccountConfig(authPath).managementKey;
  return typeof value === "string" ? cleanApiKey(value) : null;
}

export function readOpenRouterCreditBaseline(authPath: string): number | null {
  const value = flexibleNumber(readAccountConfig(authPath).creditBaselineUsd);
  return value !== null && value > 0 ? value : null;
}

export function writeOpenRouterAccountConfig(
  authPath: string,
  update: { managementKey?: string | null; creditBaselineUsd?: number | null },
): void {
  const path = accountConfigPath(authPath);
  const config = readAccountConfig(authPath);
  for (const [key, value] of Object.entries(update)) {
    if (value === null) delete config[key];
    else if (value !== undefined) config[key] = value;
  }
  if (Object.keys(config).length === 0) {
    if (existsSync(path)) unlinkSync(path);
  } else {
    atomicWriteText(path, `${JSON.stringify(config)}\n`);
  }
}

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
  if (scope.kind === "account" && !scope.authPath) return null;
  const stored = cleanApiKey(
    readPiApiKey("openrouter", scope.authPath ? { authPath: scope.authPath } : undefined),
  );
  if (stored) return stored;
  if (scope.kind === "account") return null;
  return cleanApiKey(process.env.OPENROUTER_API_KEY);
}

/** Exported for unit tests. */
export function parseOpenRouterCreditsJson(json: string): { used: number; total: number; balance: number } {
  const data = asRecord(asRecord(JSON.parse(json))?.data);
  const total = flexibleNumber(data?.total_credits);
  const used = flexibleNumber(data?.total_usage);
  if (total === null || used === null || total < 0 || used < 0) {
    throw new ProviderError("OpenRouter の残高応答形式が不正です。");
  }
  return { used, total, balance: Math.max(0, total - used) };
}

/** Exported for unit tests. */
export function parseOpenRouterKeyJson(json: string): UsageSnapshot {
  const root = asRecord(JSON.parse(json));
  const data = asRecord(root?.data);
  if (!data) throw new ProviderError("OpenRouter の応答形式が不正です。");

  const usage = flexibleNumber(data.usage) ?? 0;
  const limit = flexibleNumber(data.limit);
  const isFreeTier = data.is_free_tier === true;

  return openRouterSnapshot(usage, limit, isFreeTier);
}

function openRouterSnapshot(usage: number, limit: number | null, isFreeTier: boolean): UsageSnapshot {
  return {
    providerId: "openrouter",
    providerName: "OpenRouter",
    plan: isFreeTier ? "Free" : "Pay-as-you-go",
    accountEmail: null,
    windows: [],
    creditsEnabled: true,
    creditsTitle: "キー利用枠",
    creditsUsed: usage,
    creditsLimit: limit !== null && limit > 0 ? limit : null,
    creditsBalance: null,
    creditsLabel: null,
    sourceLabel: "openrouter.ai/api/v1/key",
    updatedAt: new Date(),
    isStale: false,
    rateLimitResetCreditsAvailable: null,
  };
}

export function createOpenRouterProvider(scope: UsageScope): IUsageProvider {
  return {
    id: "openrouter",
    name: "OpenRouter",
    isConfigured() {
      return resolveOpenRouterApiKey(scope) !== null ||
        (scope.kind === "account" && !!scope.authPath && readOpenRouterManagementKey(scope.authPath) !== null) ||
        (scope.kind === "default" && cleanApiKey(process.env.OPENROUTER_MANAGEMENT_KEY) !== null);
    },
    async fetch(signal) {
      const apiKey = resolveOpenRouterApiKey(scope);
      // Account scopes never fall back to a global management key.
      const managementKey = scope.kind === "account"
        ? scope.authPath ? readOpenRouterManagementKey(scope.authPath) : null
        : cleanApiKey(process.env.OPENROUTER_MANAGEMENT_KEY);
      if (!apiKey && !managementKey) throw new ProviderError("API キーが未設定です");

      let snapshot = openRouterSnapshot(0, null, false);
      if (apiKey && !managementKey) {
        const { status, body, ok } = await fetchText(KEY_API_URL, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          signal,
        });
        if (status === 401 || status === 403) {
          throw new ProviderError("API キーが無効です");
        }
        if (!ok) {
          const snippet = body.length > 200 ? body.slice(0, 200) : body;
          throw new ProviderError(`OpenRouter API エラー HTTP ${status}: ${snippet}`);
        }
        try {
          snapshot = parseOpenRouterKeyJson(body);
        } catch (err) {
          if (err instanceof ProviderError) throw err;
          throw new ProviderError("OpenRouter の応答を解析できませんでした。", { cause: err });
        }
      }
      if (!managementKey) return snapshot;

      const credits = await fetchText(CREDITS_API_URL, {
        headers: { Authorization: `Bearer ${managementKey}`, Accept: "application/json" },
        signal,
      });
      if (credits.status === 401 || credits.status === 403) {
        throw new ProviderError("OpenRouter の管理キーが無効です。");
      }
      if (!credits.ok) {
        throw new ProviderError(`OpenRouter の残高取得に失敗しました (HTTP ${credits.status})。`);
      }
      let amounts: ReturnType<typeof parseOpenRouterCreditsJson>;
      try {
        amounts = parseOpenRouterCreditsJson(credits.body);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError("OpenRouter の残高応答を解析できませんでした。", { cause: err });
      }
      return applyCreditBaseline({
        ...snapshot,
        creditsTitle: "アカウント残高",
        creditsUsed: null,
        creditsLimit: null,
        creditsBalance: amounts.balance,
        usageDisplayOnly: true,
        sourceLabel: "openrouter.ai/api/v1/credits",
      }, scope.authPath ? readOpenRouterCreditBaseline(scope.authPath) : null);
    },
  };
}

export const openrouterProvider: IUsageProvider = createOpenRouterProvider(DEFAULT_SCOPE);
