import type { CodexBarProviderGroup } from "@/lib/codexbar";
import type { ProviderTokenUsage, TokenUsageEstimate } from "@shared/ui-owner-dtos";

/** Display-only sums; never calibrate against the parent's average usage percentage. */
export function aggregateTokenUsage(group: CodexBarProviderGroup): {
  usage: ProviderTokenUsage;
  measuredAccounts: number;
  totalAccounts: number;
} | null {
  const accounts = group.accountRows.filter((row) => row.configured);
  const measured = accounts.flatMap((row) => row.provider?.tokenUsage ? [row.provider.tokenUsage] : []);
  if (!measured.length) return null;

  const usage: ProviderTokenUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, responses: 0,
    startedAt: null, windows: [],
  };
  for (const value of measured) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "responses"] as const) {
      usage[key] += value[key];
    }
  }
  const started = measured.map((value) => Date.parse(value.startedAt ?? "")).filter(Number.isFinite);
  if (started.length) usage.startedAt = new Date(Math.min(...started)).toISOString();

  // Global balance/display-only rows are not additional independent account quotas.
  const quotaAccounts = accounts.filter((row) => row.provider?.usageDisplayOnly !== true);
  const windows = new Map(quotaAccounts.flatMap((row) =>
    row.provider?.tokenUsage?.windows.map((window) => [window.id, window] as const) ?? []));
  usage.windows = [...windows.values()].map((window): TokenUsageEstimate => {
    const entries = quotaAccounts.map((row) => row.provider?.tokenUsage?.windows.find((entry) => entry.id === window.id));
    const unready = entries.find((entry) => !entry || (entry.status !== undefined && entry.status !== "ready") ||
      entry.tokensPerPercent === null || entry.estimatedRemainingTokens === null ||
      !Number.isFinite(entry.tokensPerPercent) || entry.tokensPerPercent <= 0 ||
      !Number.isFinite(entry.estimatedRemainingTokens) || entry.estimatedRemainingTokens < 0 ||
      !Number.isFinite(entry.estimatedTotalTokens ?? entry.tokensPerPercent * 100) ||
      (entry.estimatedTotalTokens ?? entry.tokensPerPercent * 100) <= 0 ||
      entry.estimatedRemainingTokens > (entry.estimatedTotalTokens ?? entry.tokensPerPercent * 100));
    const complete = entries.every((entry) => entry !== undefined) && unready === undefined;
    const deadlines = entries.flatMap((entry) => entry?.validUntil ? [Date.parse(entry.validUntil)] : []);
    const invalidDeadline = deadlines.some((deadline) => !Number.isFinite(deadline));
    const status = complete && !invalidDeadline ? "ready"
      : invalidDeadline || entries.some((entry) => !entry) ? "invalid"
      : unready?.status && unready.status !== "ready" ? unready.status : "calibrating";
    return {
      id: window.id, title: window.title, status,
      validUntil: deadlines.length && !invalidDeadline ? new Date(Math.min(...deadlines)).toISOString() : null,
      sampledTokens: 0, sampledPercent: 0, tokensPerPercent: null,
      estimatedRemainingTokens: status === "ready"
        ? entries.reduce((sum, entry) => sum + entry!.estimatedRemainingTokens!, 0) : null,
      estimatedTotalTokens: status === "ready"
        ? entries.reduce((sum, entry) => sum + (entry!.estimatedTotalTokens ?? entry!.tokensPerPercent! * 100), 0) : null,
    };
  });
  return { usage, measuredAccounts: measured.length, totalAccounts: accounts.length };
}
