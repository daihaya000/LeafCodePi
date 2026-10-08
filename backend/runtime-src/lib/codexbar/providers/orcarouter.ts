/** OrcaRouter workspace billing via its OpenAI-shaped dashboard endpoints. */

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

export const ORCAROUTER_BILLING_BASE = "https://api.orcarouter.ai/v1";
const DEFAULT_SCOPE: UsageScope = {
  key: "default",
  kind: "default",
  accountId: null,
  accountLabel: null,
  authPath: null,
};

type Subscription = {
  hardLimitUsd: number | null;
  hasPaymentMethod: boolean | null;
};

function jsonRecord(text: string): Record<string, unknown> {
  try {
    const root = asRecord(JSON.parse(text));
    if (root) return root;
  } catch {
    // Normalize malformed responses to the provider error below.
  }
  throw new ProviderError("OrcaRouter の請求応答形式が不正です。");
}

function responseData(root: Record<string, unknown>): Record<string, unknown> {
  return asRecord(root.data) ?? root;
}

function parseSubscription(text: string): Subscription {
  const root = responseData(jsonRecord(text));
  const hardLimitUsd =
    flexibleNumber(root.hard_limit_usd) ??
    flexibleNumber(root.system_hard_limit_usd) ??
    flexibleNumber(root.soft_limit_usd);
  return {
    hardLimitUsd,
    hasPaymentMethod:
      typeof root.has_payment_method === "boolean"
        ? root.has_payment_method
        : null,
  };
}

function parseTotalUsageUsd(text: string): number {
  const root = responseData(jsonRecord(text));
  const totalUsage =
    flexibleNumber(root.total_usage_usd) ?? flexibleNumber(root.total_usage);
  if (totalUsage === null || totalUsage < 0) {
    throw new ProviderError("OrcaRouter の利用額が応答にありません。");
  }
  // OpenAIUsageResponse.TotalUsage is expressed in cents.
  return flexibleNumber(root.total_usage_usd) !== null
    ? totalUsage
    : totalUsage / 100;
}

/** Parse the OpenAI-shaped subscription and usage responses. */
export function parseOrcaRouterBilling(
  subscriptionText: string,
  usageText: string,
): UsageSnapshot {
  const subscription = parseSubscription(subscriptionText);
  const usedUsd = parseTotalUsageUsd(usageText);
  const limitUsd =
    subscription.hardLimitUsd !== null && subscription.hardLimitUsd > 0
      ? subscription.hardLimitUsd
      : null;
  const balanceUsd =
    limitUsd === null ? null : Math.max(0, limitUsd - usedUsd);

  return {
    providerId: "orcarouter",
    providerName: "OrcaRouter",
    plan: subscription.hasPaymentMethod === true ? "Pay-as-you-go" : null,
    accountEmail: null,
    windows: [],
    creditsEnabled: true,
    creditsTitle: "利用額",
    creditsUsed: usedUsd,
    creditsLimit: limitUsd,
    creditsBalance: balanceUsd,
    creditsLabel: "USD",
    sourceLabel: "api.orcarouter.ai/v1/dashboard/billing",
    updatedAt: new Date(),
    isStale: false,
    rateLimitResetCreditsAvailable: null,
  };
}

export function resolveOrcaRouterApiKey(
  scope: UsageScope = DEFAULT_SCOPE,
): string | null {
  const stored = cleanApiKey(
    readPiApiKey(
      "orcarouter",
      scope.authPath ? { authPath: scope.authPath } : undefined,
    ),
  );
  if (stored) return stored;
  if (scope.kind === "account") return null;
  return cleanApiKey(process.env.ORCAROUTER_API_KEY);
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function usageStartDate(hasPaymentMethod: boolean | null, now: Date): string {
  if (hasPaymentMethod === false) {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 100);
    return dateOnly(start);
  }
  return dateOnly(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
}

async function fetchBilling(
  apiKey: string,
  signal?: AbortSignal,
): Promise<UsageSnapshot> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  const subscriptionResponse = await fetchText(
    `${ORCAROUTER_BILLING_BASE}/dashboard/billing/subscription`,
    { headers, signal, timeoutMs: 10_000 },
  );
  if (subscriptionResponse.status === 401 || subscriptionResponse.status === 403) {
    throw new ProviderError("OrcaRouter の API キーが無効です。");
  }
  if (!subscriptionResponse.ok) {
    throw new ProviderError(
      `OrcaRouter の契約情報取得に失敗しました (HTTP ${subscriptionResponse.status})。`,
    );
  }

  const subscription = parseSubscription(subscriptionResponse.body);
  const now = new Date();
  const usageUrl = new URL(`${ORCAROUTER_BILLING_BASE}/dashboard/billing/usage`);
  usageUrl.searchParams.set("start_date", usageStartDate(subscription.hasPaymentMethod, now));
  usageUrl.searchParams.set("end_date", dateOnly(now));
  const usageResponse = await fetchText(usageUrl.toString(), {
    headers,
    signal,
    timeoutMs: 10_000,
  });
  if (usageResponse.status === 401 || usageResponse.status === 403) {
    throw new ProviderError("OrcaRouter の API キーが無効です。");
  }
  if (!usageResponse.ok) {
    throw new ProviderError(
      `OrcaRouter の利用額取得に失敗しました (HTTP ${usageResponse.status})。`,
    );
  }

  return parseOrcaRouterBilling(
    subscriptionResponse.body,
    usageResponse.body,
  );
}

export function createOrcaRouterProvider(scope: UsageScope): IUsageProvider {
  return {
    id: "orcarouter",
    name: "OrcaRouter",
    isConfigured() {
      return resolveOrcaRouterApiKey(scope) !== null;
    },
    fetch(signal) {
      const apiKey = resolveOrcaRouterApiKey(scope);
      if (!apiKey) throw new ProviderError("API キーが未設定です。");
      return fetchBilling(apiKey, signal);
    },
  };
}

export const orcarouterProvider: IUsageProvider =
  createOrcaRouterProvider(DEFAULT_SCOPE);
