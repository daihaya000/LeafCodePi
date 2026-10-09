import type { CodexBarProvider } from "@/lib/codexbar";
import type { TokenUsageEstimate } from "@/lib/codexbar/token-usage-types";

const detailed = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });

/** Select the same quota as the provider summary, never add overlapping windows. */
export function summaryTokenEstimate(provider: CodexBarProvider): TokenUsageEstimate | undefined {
  if (provider.usedPercent === null || provider.usageDisplayOnly || provider.stale) return undefined;
  const window = provider.windows.find((entry) => entry.countsTowardLimit !== false && entry.usedPercent === provider.usedPercent);
  const credits = provider.credits;
  const creditPercent = credits?.used !== null && credits?.used !== undefined && credits.limit !== null && credits.limit > 0
    ? credits.used / credits.limit * 100 : null;
  const id = window?.id ?? (creditPercent === provider.usedPercent ? "credits"
    : provider.windows.length === 0 && !credits ? "provider" : undefined);
  return provider.tokenUsage?.windows.find((entry) => entry.id === id);
}

export function TokenEstimateInline({ estimate, now }: { estimate?: TokenUsageEstimate; now: number }) {
  if (!estimate || (estimate.status !== undefined && estimate.status !== "ready") ||
    (estimate.validUntil && !(Date.parse(estimate.validUntil) > now))) return null;
  const remaining = estimate.estimatedRemainingTokens;
  const total = estimate.estimatedTotalTokens ?? (estimate.tokensPerPercent === null ? null : estimate.tokensPerPercent * 100);
  if (remaining === null || total === null || !Number.isFinite(remaining) || !Number.isFinite(total) ||
    remaining < 0 || total <= 0 || remaining > total) return null;
  const used = total - remaining;
  const rate = estimate.tokensPerPercent === null ? "" : ` / ${detailed.format(estimate.tokensPerPercent)} tok/1%`;
  return (
    <span className="shrink-0 whitespace-nowrap text-[10px] tabular-nums text-muted"
      title={`利用済 ${detailed.format(used)} tok / 合計 ${detailed.format(total)} tok${rate}。同じ利用枠の総量−残量。入力・出力・キャッシュ込みの参考値であり、保証された残量ではない。`}
    >
      {compact.format(Math.round(used))}/{compact.format(Math.round(total))}
    </span>
  );
}
