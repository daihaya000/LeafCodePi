/**
 * Pure parsing + display helpers for the CodexBar usage snapshot
 * (`%APPDATA%\CodexBar\usage-snapshot.json`, schema `codexbar.usage-snapshot/v1`).
 *
 * Shared by the BFF route (server) and the widget (client): no Node/DOM deps.
 */

import { providerIconSrc as piProviderIconSrc } from "@/lib/provider-icons";

export const CODEXBAR_SCHEMA = "codexbar.usage-snapshot/v1";

/** A single rate-limit window (e.g. 5時間 / 週間 / 月間) for a provider. */
export type CodexBarWindow = {
  id: string;
  title: string;
  usedPercent: number | null;
  resetsAt: string | null;
  /** Window length in minutes (e.g. 300 = 5h, 10080 = weekly), or null. */
  windowMinutes: number | null;
};

export type CodexBarCredits = {
  title: string | null;
  used: number | null;
  limit: number | null;
  balance: number | null;
};

export type CodexBarProvider = {
  /** codexBarProviderId (codex/claude/cursor/opencode-go/ollama/synthetic), falls back to opencode id. */
  id: string;
  opencodeId: string | null;
  /** Subscription/plan label (e.g. Pro/Max/Go), or null when unknown. */
  plan: string | null;
  /** Approximate public list price USD/month for the plan, when known. */
  planMonthlyUsd: number | null;
  /** Max usage percent across windows (0..100+), or null if unknown. */
  usedPercent: number | null;
  limited: boolean;
  maxed: boolean;
  /** ISO-8601 timestamp of the earliest window reset, or null. */
  resetsAt: string | null;
  /** ISO-8601 timestamp this provider was fetched, or null. */
  updatedAt: string | null;
  /** Present only when the fetch failed. */
  error: string | null;
  /** Per-window detail (5時間/週間/…). Empty for older snapshots. */
  windows: CodexBarWindow[];
  /** Optional monetary credit allowance, separate from rate-limit windows. */
  credits: CodexBarCredits | null;
};

export type CodexBarUsage = {
  available: boolean;
  /** Human-readable reason when `available` is false. */
  reason: string | null;
  schema: string | null;
  generatedAt: string | null;
  /** Sum of known planMonthlyUsd across providers (from CodexBar export). */
  subscriptionTotalMonthlyUsd: number | null;
  providers: CodexBarProvider[];
};

export function emptyUsage(reason: string): CodexBarUsage {
  return {
    available: false,
    reason,
    schema: null,
    generatedAt: null,
    subscriptionTotalMonthlyUsd: null,
    providers: [],
  };
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Defensively normalize an arbitrary parsed snapshot into `CodexBarUsage`.
 * Never throws; unknown shapes yield `available: false`.
 */
export function parseCodexBarSnapshot(raw: unknown): CodexBarUsage {
  if (!raw || typeof raw !== "object") {
    return emptyUsage("スナップショットの形式が不正です");
  }
  const obj = raw as Record<string, unknown>;
  const list = obj.providers;
  if (!Array.isArray(list)) {
    return emptyUsage("providers 配列がありません");
  }

  const providers: CodexBarProvider[] = list
    .filter(
      (p): p is Record<string, unknown> =>
        !!p && typeof p === "object" && !Array.isArray(p),
    )
    .map((p) => {
      const id = asString(p.codexBarProviderId) ?? asString(p.opencodeProviderId) ?? "unknown";
      const rawUsedPercent = asNumber(p.usedPercent);
      const windows: CodexBarWindow[] = Array.isArray(p.windows)
        ? p.windows
            .filter(
              (w): w is Record<string, unknown> =>
                !!w && typeof w === "object" && !Array.isArray(w),
            )
            .map((w) => ({
              id: asString(w.id) ?? "",
              title: asString(w.title) ?? "",
              usedPercent: asNumber(w.usedPercent),
              resetsAt: asString(w.resetsAt),
              windowMinutes: asNumber(w.windowMinutes),
            }))
        : [];
      const creditValue = p.credits;
      const credits: CodexBarCredits | null =
        creditValue && typeof creditValue === "object" && !Array.isArray(creditValue)
          ? {
              title: asString((creditValue as Record<string, unknown>).title),
              used: asNumber((creditValue as Record<string, unknown>).used),
              limit: asNumber((creditValue as Record<string, unknown>).limit),
              balance: asNumber((creditValue as Record<string, unknown>).balance),
            }
          : null;
      const creditPercent =
        credits !== null && credits.used !== null && credits.limit !== null && credits.limit > 0
          ? (credits.used / credits.limit) * 100
          : null;
      const usedPercent =
        id === "openrouter" &&
        windows.length === 0 &&
        credits !== null &&
        credits.used !== null &&
        credits.limit === null
          ? null
          : rawUsedPercent;
      const representative =
        usedPercent === null
          ? creditPercent
          : creditPercent === null
            ? usedPercent
            : Math.max(usedPercent, creditPercent);
      return {
        id,
        opencodeId: asString(p.opencodeProviderId),
        plan: asString(p.plan),
        planMonthlyUsd: asNumber(p.planMonthlyUsd),
        usedPercent: representative,
        limited: p.limited === true || (representative !== null && representative >= 90),
        maxed: p.maxed === true || (representative !== null && representative >= 99.5),
        resetsAt: asString(p.resetsAt),
        updatedAt: asString(p.updatedAt),
        error: asString(p.error),
        windows,
        credits,
      };
    });

  let subscriptionTotalMonthlyUsd = asNumber(obj.subscriptionTotalMonthlyUsd);
  if (subscriptionTotalMonthlyUsd === null) {
    const prices = providers
      .map((p) => p.planMonthlyUsd)
      .filter((v): v is number => v !== null);
    if (prices.length > 0) {
      subscriptionTotalMonthlyUsd = prices.reduce((a, b) => a + b, 0);
    }
  }

  return {
    available: true,
    reason: null,
    schema: asString(obj.schema),
    generatedAt: asString(obj.generatedAt),
    subscriptionTotalMonthlyUsd,
    providers,
  };
}

const PROVIDER_LABELS: Record<string, string> = {
  "openai-codex": "Codex",
  anthropic: "Claude",
  commandcode: "CommandCode",
  "command-code": "CommandCode",
  cursor: "Cursor",
  "opencode-go": "OpenCode",
  "ollama-cloud": "Ollama",
  synthetic: "Synthetic",
  "qwen-cloud": "Qwen Cloud",
  qwen: "Qwen Cloud",
  openrouter: "OpenRouter",
  lmstudio: "LM Studio",
  "llama-server": "llama-server",
};

export function providerLabel(id: string): string {
  const known = PROVIDER_LABELS[id];
  if (known) return known;
  if (!id) return "Unknown";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Public path of a provider's icon, or null when there is no bundled icon. */
export function providerIconSrc(id: string): string | null {
  return piProviderIconSrc(id);
}

/** Public path of a brand icon for an OpenCode/Pi provider id, or null. */
export function providerIconSrcForOpencodeId(opencodeId: string): string | null {
  return piProviderIconSrc(opencodeId);
}

/** Format a whole-dollar monthly price like CodexBar (`$20` / `$100/月`). */
export function formatMonthlyUsd(usd: number): string {
  if (Math.abs(usd - Math.round(usd)) < 0.001) {
    return `$${Math.round(usd)}`;
  }
  return `$${usd.toFixed(2)}`;
}

export function formatMonthlyTotal(usd: number): string {
  return `${formatMonthlyUsd(usd)}/月`;
}

/** Plan badge text: `Pro · $20` when a price is known. */
export function formatPlanBadge(
  plan: string | null,
  planMonthlyUsd: number | null,
): string | null {
  if (!plan) return null;
  if (planMonthlyUsd !== null && planMonthlyUsd > 0) {
    return `${plan} · ${formatMonthlyUsd(planMonthlyUsd)}`;
  }
  return plan;
}

export type UsageTone = "ok" | "warn" | "danger";

export function hasLastGoodUsage(
  p: Pick<CodexBarProvider, "usedPercent" | "error" | "windows" | "credits">,
): boolean {
  if ((p.windows?.length ?? 0) > 0) return true;
  if (
    p.credits !== null &&
    (p.credits.title !== null ||
      p.credits.used !== null ||
      p.credits.limit !== null ||
      p.credits.balance !== null)
  ) {
    return true;
  }
  if (p.usedPercent === null) return false;
  if (p.error && p.usedPercent === 0) return false;
  return true;
}

export function usageTone(
  p: Pick<CodexBarProvider, "usedPercent" | "limited" | "maxed" | "error" | "windows" | "credits">,
): UsageTone {
  if (p.error && !hasLastGoodUsage(p)) return "danger";
  if (p.maxed || p.limited) return "danger";
  const u = p.usedPercent ?? 0;
  if (u >= 75) return "warn";
  return "ok";
}

export function percentTone(usedPercent: number | null): UsageTone {
  const u = usedPercent ?? 0;
  if (u >= 90) return "danger";
  if (u >= 75) return "warn";
  return "ok";
}

export function overallUsedPercent(usage: CodexBarUsage): number | null {
  const vals = usage.providers
    .filter((p) => hasLastGoodUsage(p) && p.usedPercent !== null)
    .map((p) => p.usedPercent as number);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function limitedCount(usage: CodexBarUsage): number {
  return usage.providers.filter((p) => p.limited || p.maxed).length;
}

export function clampPercent(v: number | null): number {
  if (v === null || Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

export function formatResetsIn(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diff = t - nowMs;
  if (diff <= 0) return "まもなく";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}分後`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間後`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}日${remHours}時間後` : `${days}日後`;
}

export const STALE_AFTER_MS = 15 * 60 * 1000;

export function isStale(
  generatedAt: string | null,
  nowMs: number,
  thresholdMs: number = STALE_AFTER_MS,
): boolean {
  if (!generatedAt) return false;
  const t = Date.parse(generatedAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t > thresholdMs;
}

export function worstProvider(usage: CodexBarUsage): CodexBarProvider | null {
  let worst: CodexBarProvider | null = null;
  for (const p of usage.providers) {
    if (p.error && !hasLastGoodUsage(p)) return p;
    if (!worst || (p.usedPercent ?? -1) > (worst.usedPercent ?? -1)) worst = p;
  }
  return worst;
}
