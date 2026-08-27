/**
 * Command Code Studio usage via documented bearer-token API.
 * Key: COMMAND_CODE_API_KEY or ~/.commandcode/auth.json
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { readPiOAuthTokens, readPiApiKey } from "@/lib/codexbar/pi-auth";
import type { UsageScope } from "@/lib/codexbar/types";

const API_BASE = "https://api.commandcode.ai";

function child(
  value: unknown,
  ...names: string[]
): Record<string, unknown> | unknown {
  let current: unknown = value;
  for (const name of names) {
    const obj = asRecord(current);
    if (!obj || !(name in obj)) return null;
    current = obj[name];
  }
  return current;
}

function readString(value: unknown, ...names: string[]): string | null {
  const c = child(value, ...names);
  return typeof c === "string" ? c : null;
}

function readDouble(value: unknown, name: string): number | null {
  const c = child(value, name);
  return flexibleNumber(c);
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

function displayPlan(planId: string | null): string | null {
  if (!planId?.trim()) return null;
  const normalized = planId.trim().toLowerCase().replace(/_/g, "-");
  if (normalized.includes("goat")) return "GOAT";
  if (normalized.includes("go")) return "Go";
  if (normalized.includes("provider")) return "Provider";
  if (normalized.includes("max")) {
    return normalized.includes("20") ? "Max 20x" : "Max 10x";
  }
  if (normalized.includes("team")) return "Team Pro";
  if (normalized.includes("pro")) return "Pro";
  return planId;
}

function monthlyCredits(planId: string | null): number | null {
  if (!planId?.trim()) return null;
  const normalized = planId.trim().toLowerCase().replace(/_/g, "-");
  if (normalized.includes("goat")) return 70;
  if (normalized.includes("go")) return 10;
  if (normalized.includes("provider")) return 15;
  if (normalized.includes("max-20")) return 300;
  if (normalized.includes("max")) return 150;
  if (normalized.includes("team")) return 40;
  if (normalized.includes("pro")) return 30;
  return null;
}

function addWindow(
  windows: RateWindow[],
  credits: unknown,
  response: unknown,
  key: string,
  id: string,
  title: string,
  durationMs: number,
): void {
  const value =
    child(credits, "windowLimits", key) ?? child(response, "windowLimits", key);
  const used = readDouble(value, "used");
  const cap = readDouble(value, "cap");
  if (used === null || cap === null || !(cap > 0)) return;
  windows.push({
    id,
    title,
    usedPercent: clamp((used / cap) * 100, 0, 100),
    resetsAt: parseDate(readString(value, "resetAt")),
    windowDurationMs: durationMs,
    countsTowardLimit: true,
  });
}

export function resolveCommandCodeApiKey(options?: {
  authPath?: string | null;
}): string | null {
  if (options !== undefined) {
    if (!options.authPath) return null;
    return (
      cleanApiKey(
        readPiOAuthTokens("commandcode", { authPath: options.authPath })
          ?.access ?? null,
      ) ??
      cleanApiKey(readPiApiKey("commandcode", { authPath: options.authPath }))
    );
  }
  const fromEnv =
    cleanApiKey(process.env.COMMANDCODE_API_KEY) ??
    cleanApiKey(process.env.COMMAND_CODE_API_KEY);
  if (fromEnv) return fromEnv;
  const fromPi = cleanApiKey(readPiOAuthTokens("commandcode")?.access);
  if (fromPi) return fromPi;
  const fromPiApiKey = cleanApiKey(readPiApiKey("commandcode"));
  if (fromPiApiKey) return fromPiApiKey;
  try {
    const path = join(homedir(), ".commandcode", "auth.json");
    if (!existsSync(path)) return null;
    const root = asRecord(JSON.parse(readFileSync(path, "utf8")));
    return (
      cleanApiKey(typeof root?.apiKey === "string" ? root.apiKey : null) ??
      cleanApiKey(typeof root?.api_key === "string" ? root.api_key : null)
    );
  } catch {
    return null;
  }
}

function resolveCommandCodeApiKeyForScope(scope: UsageScope): string | null {
  return scope.kind === "account"
    ? resolveCommandCodeApiKey({ authPath: scope.authPath })
    : resolveCommandCodeApiKey();
}

export function createCommandCodeProvider(scope: UsageScope): IUsageProvider {
  return {
    id: "commandcode",
    name: "Command Code",
    isConfigured() {
      return resolveCommandCodeApiKeyForScope(scope) !== null;
    },
    async fetch(signal) {
      const apiKey = resolveCommandCodeApiKeyForScope(scope);
      if (!apiKey) {
        throw new ProviderError(
          "Command Code の API キーが見つかりません。COMMAND_CODE_API_KEY またはアカウントの認証を設定してください。",
        );
      }
      const whoami = await getJson("/alpha/whoami", apiKey, signal);
      const orgId = readString(whoami, "org", "id");
      const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
      const credits = await getJson(
        `/alpha/billing/credits${query}`,
        apiKey,
        signal,
      );
      const subscription = await getJson(
        `/alpha/billing/subscriptions${query}`,
        apiKey,
        signal,
      );
      return parseCommandCodeSnapshot(whoami, credits, subscription);
    },
  };
}

/** Exported for unit tests. */
export function parseCommandCodeSnapshot(
  whoami: unknown,
  creditsResponse: unknown,
  subscriptionResponse: unknown,
): UsageSnapshot {
  const credits = child(creditsResponse, "credits");
  const subscription = child(subscriptionResponse, "data");
  const planId =
    readString(subscription, "planId") ?? readString(credits, "planId");
  const plan = displayPlan(planId);
  const monthlyLimit = monthlyCredits(planId);
  const monthlyRemaining = readDouble(credits, "monthlyCredits") ?? 0;
  const totalRemaining =
    monthlyRemaining +
    (readDouble(credits, "purchasedCredits") ?? 0) +
    (readDouble(credits, "freeCredits") ?? 0);

  const windows: RateWindow[] = [];
  addWindow(
    windows,
    credits,
    creditsResponse,
    "fiveHour",
    "commandcode-5h",
    "5時間",
    5 * 3600_000,
  );
  addWindow(
    windows,
    credits,
    creditsResponse,
    "weekly",
    "commandcode-weekly",
    "週間",
    7 * 86400_000,
  );

  return {
    providerId: "commandcode",
    providerName: "Command Code",
    plan,
    accountEmail: readString(whoami, "user", "email"),
    windows,
    creditsEnabled: monthlyLimit !== null || totalRemaining > 0,
    creditsTitle: "クレジット",
    creditsUsed:
      monthlyLimit !== null && monthlyLimit > 0
        ? clamp(monthlyLimit - monthlyRemaining, 0, monthlyLimit)
        : null,
    creditsLimit: monthlyLimit,
    creditsBalance: totalRemaining,
    creditsLabel: null,
    sourceLabel: "Command Code API",
    updatedAt: new Date(),
    isStale: false,
  };
}

async function getJson(
  path: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const { status, body, ok } = await fetchText(API_BASE + path, {
    headers: {
      Accept: "application/json",
      "User-Agent": "CodexBar/1.0",
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
  });
  if (status === 401 || status === 403) {
    throw new ProviderError(
      "Command Code のセッションが期限切れです。API キーを再設定してください。",
    );
  }
  if (!ok) {
    throw new ProviderError(
      `Command Code API が HTTP ${status} を返しました。`,
    );
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new ProviderError("Command Code API の応答を読み取れませんでした。", {
      cause: err,
    });
  }
}

export const commandcodeProvider: IUsageProvider = createCommandCodeProvider({
  key: "default",
  kind: "default",
  accountId: null,
  accountLabel: null,
  authPath: null,
});
