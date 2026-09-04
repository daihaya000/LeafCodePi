/**
 * Synthetic usage via GET https://api.synthetic.new/v2/quotas.
 * Parser covers prioritized rolling/weekly/search slots + generic fallback.
 */

import {
  ProviderError,
  type IUsageProvider,
  type RateWindow,
  type UsageSnapshot,
} from "@/lib/codexbar/types";
import {
  asRecord,
  cleanApiKey,
  clamp,
  fetchText,
  flexibleNumber,
} from "@/lib/codexbar/utils";

const QUOTA_API_URL = "https://api.synthetic.new/v2/quotas";

const PLAN_KEYS = [
  "plan",
  "planName",
  "plan_name",
  "subscription",
  "subscriptionPlan",
  "tier",
  "package",
  "packageName",
];
const LABEL_KEYS = ["name", "label", "type", "period", "scope", "title", "id"];
const PERCENT_USED_KEYS = [
  "percentUsed",
  "usedPercent",
  "usagePercent",
  "usage_percent",
  "used_percent",
  "percent_used",
  "percent",
];
const PERCENT_REMAINING_KEYS = [
  "percentRemaining",
  "remainingPercent",
  "remaining_percent",
  "percent_remaining",
];
const LIMIT_KEYS = [
  "limit",
  "messageLimit",
  "message_limit",
  "messages",
  "maxRequests",
  "max_requests",
  "requestLimit",
  "request_limit",
  "quota",
  "max",
  "total",
  "capacity",
  "allowance",
];
const USED_KEYS = [
  "used",
  "usage",
  "usedMessages",
  "used_messages",
  "messagesUsed",
  "messages_used",
  "requests",
  "requestCount",
  "request_count",
  "consumed",
  "spent",
];
const REMAINING_KEYS = ["remaining", "left", "available", "balance"];
const RESET_KEYS = [
  "resetAt",
  "reset_at",
  "resetsAt",
  "resets_at",
  "renewAt",
  "renew_at",
  "renewsAt",
  "renews_at",
  "nextTickAt",
  "next_tick_at",
  "nextRegenAt",
  "next_regen_at",
  "periodEnd",
  "period_end",
  "expiresAt",
  "expires_at",
  "endAt",
  "end_at",
];
const COST_LIMIT_KEYS = ["maxCredits", "max_credits"];
const COST_REMAINING_KEYS = ["remainingCredits", "remaining_credits"];
const COST_USED_KEYS = ["usedCredits", "used_credits"];

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function firstDouble(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = flexibleNumber(obj[key]);
    if (n !== null) return n;
  }
  return null;
}

function firstDate(obj: Record<string, unknown>, keys: string[]): Date | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      if (v > 1_000_000_000_000) return new Date(v);
      if (v > 1_000_000_000) return new Date(v * 1000);
    }
    if (typeof v === "string" && v.trim()) {
      const asNum = Number(v);
      if (Number.isFinite(asNum) && asNum > 1_000_000_000) {
        return asNum > 1_000_000_000_000 ? new Date(asNum) : new Date(asNum * 1000);
      }
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return new Date(t);
    }
  }
  return null;
}

function firstCurrency(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string") {
      const cleaned = v.trim().replace(/\$/g, "").replace(/,/g, "");
      const n = Number(cleaned);
      if (Number.isFinite(n)) return n;
    }
    const n = flexibleNumber(v);
    if (n !== null) return n;
  }
  return null;
}

function normalizedPercent(value: number | null): number | null {
  if (value === null) return null;
  return value <= 1 ? value * 100 : value;
}

function isQuotaPayload(obj: Record<string, unknown>): boolean {
  return (
    firstDouble(obj, LIMIT_KEYS) !== null ||
    firstDouble(obj, USED_KEYS) !== null ||
    firstDouble(obj, REMAINING_KEYS) !== null ||
    firstDouble(obj, PERCENT_USED_KEYS) !== null ||
    firstDouble(obj, PERCENT_REMAINING_KEYS) !== null
  );
}

function sanitizeId(label: string): string {
  const chars = [...label].filter((c) => /[a-zA-Z0-9_-]/.test(c)).join("");
  return chars.length === 0 ? "quota" : chars.toLowerCase();
}

function localizeTitle(label: string, defaultTitle: string | null): string {
  if (
    defaultTitle &&
    (/rolling/i.test(label) || /five-hour/i.test(label))
  ) {
    return defaultTitle;
  }
  if (defaultTitle && (/weekly/i.test(label) || /token/i.test(label))) {
    return defaultTitle;
  }
  if (defaultTitle && /search/i.test(label)) return defaultTitle;
  return defaultTitle ?? label;
}

type ParsedQuota = {
  window: RateWindow;
  creditsUsed: number | null;
  creditsLimit: number | null;
  creditsRemaining: number | null;
};

function parseQuota(
  payload: Record<string, unknown>,
  defaultTitle: string | null,
): ParsedQuota | null {
  const label = firstString(payload, LABEL_KEYS) ?? defaultTitle ?? "クォータ";
  let percentUsed = normalizedPercent(firstDouble(payload, PERCENT_USED_KEYS));
  const percentRemaining = normalizedPercent(
    firstDouble(payload, PERCENT_REMAINING_KEYS),
  );
  if (percentUsed === null && percentRemaining !== null) {
    percentUsed = 100 - percentRemaining;
  }
  if (percentUsed === null) {
    let limit = firstDouble(payload, LIMIT_KEYS);
    let used = firstDouble(payload, USED_KEYS);
    const remaining = firstDouble(payload, REMAINING_KEYS);
    if (limit === null && used !== null && remaining !== null) limit = used + remaining;
    if (used === null && limit !== null && remaining !== null) used = limit - remaining;
    if (limit !== null && limit > 0 && used !== null) {
      percentUsed = (used / limit) * 100;
    }
  }
  if (percentUsed === null) return null;
  const clamped = clamp(percentUsed, 0, 100);

  let durationMs: number | null = null;
  if (defaultTitle === "5時間") durationMs = 5 * 3600_000;
  if (defaultTitle === "週間トークン") durationMs = 7 * 86400_000;
  if (defaultTitle === "Search 時間") durationMs = 3600_000;

  const resetsAt = firstDate(payload, RESET_KEYS);
  const window: RateWindow = {
    id: `synthetic-${sanitizeId(label)}`,
    title: localizeTitle(label, defaultTitle),
    usedPercent: clamped,
    resetsAt,
    windowDurationMs: durationMs,
    countsTowardLimit: true,
  };

  const creditsLimit = firstCurrency(payload, COST_LIMIT_KEYS);
  const creditsRemaining = firstCurrency(payload, COST_REMAINING_KEYS);
  let creditsUsed = firstCurrency(payload, COST_USED_KEYS);
  if (creditsLimit !== null) {
    if (creditsUsed === null && creditsRemaining !== null) {
      creditsUsed = Math.max(0, creditsLimit - creditsRemaining);
    } else if (creditsUsed === null) {
      creditsUsed = (clamped / 100) * creditsLimit;
    }
  }

  return { window, creditsUsed, creditsLimit, creditsRemaining };
}

function namedQuota(candidate: unknown): Record<string, unknown> | null {
  const obj = asRecord(candidate);
  if (!obj || !isQuotaPayload(obj)) return null;
  return obj;
}

function defaultTitleForSlot(index: number): string {
  switch (index) {
    case 0:
      return "5時間";
    case 1:
      return "週間トークン";
    case 2:
      return "Search 時間";
    default:
      return "クォータ";
  }
}

function tryPrioritizedSlots(
  root: Record<string, unknown>,
): (Record<string, unknown> | null)[] | null {
  const data = asRecord(root.data);
  const rolling =
    namedQuota(root.rollingFiveHourLimit) ??
    (data ? namedQuota(data.rollingFiveHourLimit) : null);
  const weekly =
    namedQuota(root.weeklyTokenLimit) ??
    (data ? namedQuota(data.weeklyTokenLimit) : null);
  let searchHourly: Record<string, unknown> | null = null;
  const search = asRecord(root.search) ?? (data ? asRecord(data.search) : null);
  if (search) searchHourly = namedQuota(search.hourly);
  if (!rolling && !weekly && !searchHourly) return null;
  return [rolling, weekly, searchHourly];
}

function extractQuotaObjects(candidate: unknown): Record<string, unknown>[] {
  if (Array.isArray(candidate)) {
    return candidate.flatMap((e) => extractQuotaObjects(e));
  }
  const obj = asRecord(candidate);
  if (!obj) return [];
  if (isQuotaPayload(obj)) return [obj];
  const out: Record<string, unknown>[] = [];
  for (const key of Object.keys(obj).sort()) {
    out.push(...extractQuotaObjects(obj[key]));
  }
  return out;
}

function fallbackQuotaObjects(root: Record<string, unknown>): Record<string, unknown>[] {
  const data = asRecord(root.data);
  const candidates = [
    root.quotas,
    root.quota,
    root.limits,
    root.usage,
    root.entries,
    root.subscription,
    root.data,
    data?.quotas,
    data?.quota,
    data?.limits,
    data?.usage,
    data?.entries,
    data?.subscription,
  ];
  for (const c of candidates) {
    const found = extractQuotaObjects(c);
    if (found.length > 0) return found;
  }
  return [];
}

export function resolveSyntheticApiKey(): string | null {
  return cleanApiKey(process.env.SYNTHETIC_API_KEY);
}

/** Exported for unit tests. */
export function parseSyntheticQuotasJson(json: string): UsageSnapshot {
  let parsed: unknown = JSON.parse(json);
  if (Array.isArray(parsed)) {
    parsed = { quotas: parsed };
  }
  const root = asRecord(parsed);
  if (!root) throw new ProviderError("Synthetic の応答形式が不正です。");

  let planName = firstString(root, PLAN_KEYS);
  const dataForPlan = asRecord(root.data);
  if (!planName && dataForPlan) planName = firstString(dataForPlan, PLAN_KEYS);
  if (
    planName &&
    (planName.startsWith("{") || planName.toLowerCase() === "subscription")
  ) {
    planName = null;
  }

  const windows: RateWindow[] = [];
  let creditsUsed: number | null = null;
  let creditsLimit: number | null = null;
  let creditsBalance: number | null = null;

  const slots = tryPrioritizedSlots(root);
  if (slots) {
    for (let i = 0; i < slots.length; i++) {
      const payload = slots[i];
      if (!payload) continue;
      const entry = parseQuota(payload, defaultTitleForSlot(i));
      if (!entry) continue;
      windows.push(entry.window);
      if (entry.creditsLimit !== null) {
        creditsLimit = entry.creditsLimit;
        creditsUsed = entry.creditsUsed;
        creditsBalance = entry.creditsRemaining;
      }
    }
  } else {
    for (const payload of fallbackQuotaObjects(root)) {
      const entry = parseQuota(payload, null);
      if (!entry) continue;
      windows.push(entry.window);
      if (entry.creditsLimit !== null && creditsLimit === null) {
        creditsLimit = entry.creditsLimit;
        creditsUsed = entry.creditsUsed;
        creditsBalance = entry.creditsRemaining;
      }
    }
  }

  if (windows.length === 0) {
    throw new ProviderError("Synthetic のクォータデータがありません。");
  }

  const creditsEnabled = creditsLimit !== null && creditsLimit > 0;
  return {
    providerId: "synthetic",
    providerName: "Synthetic",
    plan: planName,
    accountEmail: null,
    windows,
    creditsEnabled,
    creditsTitle: creditsEnabled ? "週間クレジット" : null,
    creditsUsed,
    creditsLimit,
    creditsBalance,
    creditsLabel: creditsEnabled ? "Credits" : null,
    sourceLabel: "api.synthetic.new/v2/quotas",
    updatedAt: new Date(),
    isStale: false,
    rateLimitResetCreditsAvailable: null,
  };
}

export const syntheticProvider: IUsageProvider = {
  id: "synthetic",
  name: "Synthetic",
  isConfigured() {
    return resolveSyntheticApiKey() !== null;
  },
  async fetch(signal) {
    const apiKey = resolveSyntheticApiKey();
    if (!apiKey) throw new ProviderError("API キーが未設定です");

    const { status, body, ok } = await fetchText(QUOTA_API_URL, {
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
        `Synthetic API エラー HTTP ${status}: ${snippet}`,
      );
    }
    try {
      return parseSyntheticQuotasJson(body);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("Synthetic の応答を解析できませんでした。", {
        cause: err,
      });
    }
  },
};
