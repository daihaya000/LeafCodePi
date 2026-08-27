/**
 * Assembles `codexbar.usage-snapshot/v1` entries (port of CodexBarWin UsageExporter).
 */

import {
  CODEXBAR_SCHEMA,
  type CodexBarAccountProviderId,
  type CodexBarUsage,
  parseCodexBarSnapshot,
} from "@/lib/codexbar";
import { tryGetMonthlyUsd } from "@/lib/codexbar/plan-pricing";
import type { UsageSnapshot } from "@/lib/codexbar/types";
import {
  isLimited,
  isMaxed,
  representativePercent,
} from "@/lib/codexbar/utils";

export type ExportWindow = {
  id: string;
  title: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
};

export type ExportCredits = {
  title: string | null;
  used: number | null;
  limit: number | null;
  balance: number | null;
};

export type ExportEntry = {
  opencodeProviderId: string;
  instanceId: string;
  accountId: string | null;
  accountLabel: string | null;
  codexBarProviderId: string;
  plan: string | null;
  planMonthlyUsd: number | null;
  usedPercent: number | null;
  limited: boolean;
  maxed: boolean;
  resetsAt: string | null;
  updatedAt: string;
  stale: boolean;
  error: string | null;
  windows: ExportWindow[];
  credits: ExportCredits | null;
};

export type ExportScope = {
  kind: "all" | "default" | "account";
  accountId: string | null;
};

export type ExportAccountSummary = {
  id: string;
  label: string;
  providers: CodexBarAccountProviderId[];
  configuredProviders: CodexBarAccountProviderId[];
};

export type SnapshotFile = {
  schema: string;
  generatedAt: string;
  subscriptionTotalMonthlyUsd: number | null;
  scope?: ExportScope;
  accounts?: ExportAccountSummary[];
  providerOrder?: string[];
  providers: ExportEntry[];
};

export function toOpencodeProviderId(codexBarProviderId: string): string | null {
  switch (codexBarProviderId) {
    case "openai-codex":
      return "openai";
    case "anthropic":
      return "anthropic";
    case "commandcode":
      return "commandcode";
    case "opencode-go":
      return "opencode-go";
    case "ollama-cloud":
      return "ollama-cloud";
    case "cursor":
      return "cursor-acp";
    case "synthetic":
      return "synthetic";
    case "qwen-cloud":
      return "qwen-cloud";
    case "openrouter":
      return "openrouter";
    default:
      return null;
  }
}

function toIso(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString();
}

export function buildEntry(
  codexBarProviderId: string,
  snapshot: UsageSnapshot | null,
  error: string | null,
  metadata?: {
    instanceId?: string;
    accountId?: string | null;
    accountLabel?: string | null;
  },
): ExportEntry | null {
  const opencodeId = toOpencodeProviderId(codexBarProviderId);
  if (!opencodeId) return null;

  let usedPercent: number | null = null;
  let soonestReset: Date | null = null;
  const windows: ExportWindow[] = [];

  if (snapshot) {
    const anyCounting = snapshot.windows.some((w) => w.countsTowardLimit);
    for (const w of snapshot.windows) {
      const counts = w.countsTowardLimit || !anyCounting;
      if (counts && w.resetsAt && (!soonestReset || w.resetsAt < soonestReset)) {
        soonestReset = w.resetsAt;
      }
      windows.push({
        id: w.id,
        title: w.title,
        usedPercent: w.usedPercent,
        resetsAt: toIso(w.resetsAt),
        windowMinutes:
          w.windowDurationMs !== null ? w.windowDurationMs / 60_000 : null,
      });
    }
    usedPercent = representativePercent(snapshot);
  }

  const plan = snapshot?.plan ?? null;
  const hasUsableSnapshot =
    (snapshot !== null && snapshot.windows.length > 0) ||
    snapshot?.creditsEnabled === true;

  return {
    opencodeProviderId: opencodeId,
    instanceId:
      metadata?.instanceId ??
      (metadata?.accountId
        ? `account:${metadata.accountId}:${codexBarProviderId}`
        : `default:${codexBarProviderId}`),
    accountId: metadata?.accountId ?? null,
    accountLabel: metadata?.accountLabel ?? null,
    codexBarProviderId,
    plan,
    planMonthlyUsd: tryGetMonthlyUsd(codexBarProviderId, plan),
    usedPercent,
    limited: usedPercent !== null && isLimited(usedPercent),
    maxed: usedPercent !== null && isMaxed(usedPercent),
    resetsAt: toIso(soonestReset),
    updatedAt: toIso(snapshot?.updatedAt ?? new Date())!,
    stale: snapshot?.isStale === true,
    error: hasUsableSnapshot ? null : error,
    windows,
    credits: snapshot?.creditsEnabled
      ? {
          title: snapshot.creditsTitle,
          used: snapshot.creditsUsed,
          limit: snapshot.creditsLimit,
          balance: snapshot.creditsBalance,
        }
      : null,
  };
}

export function buildSnapshotFile(
  entries: ExportEntry[],
  metadata?: {
    scope?: ExportScope;
    accounts?: ExportAccountSummary[];
    providerOrder?: string[];
  },
): SnapshotFile {
  let total: number | null = null;
  for (const e of entries) {
    if (e.planMonthlyUsd === null) continue;
    total = (total ?? 0) + e.planMonthlyUsd;
  }
  return {
    schema: CODEXBAR_SCHEMA,
    generatedAt: new Date().toISOString(),
    subscriptionTotalMonthlyUsd: total,
    ...(metadata?.scope ? { scope: metadata.scope } : {}),
    ...(metadata?.accounts ? { accounts: metadata.accounts } : {}),
    ...(metadata?.providerOrder ? { providerOrder: metadata.providerOrder } : {}),
    providers: entries,
  };
}

/** Convert assembled snapshot into the widget-facing CodexBarUsage shape. */
export function buildUsageFromEntries(
  entries: ExportEntry[],
  metadata?: {
    scope?: ExportScope;
    accounts?: ExportAccountSummary[];
    providerOrder?: string[];
  },
): CodexBarUsage {
  return parseCodexBarSnapshot(buildSnapshotFile(entries, metadata));
}
