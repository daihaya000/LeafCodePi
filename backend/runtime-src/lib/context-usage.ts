export type ContextUsageDto = {
  /** Estimated context tokens, or null right after compaction. */
  tokens: number | null;
  contextWindow: number;
  /** Whole-number percentage 0–100, or null when tokens unknown. */
  percent: number | null;
};

export function toContextUsageDto(value: {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
} | null | undefined): ContextUsageDto | undefined {
  if (!value) return undefined;
  const contextWindow = Number(value.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const tokens =
    value.tokens === null || value.tokens === undefined
      ? null
      : Number.isFinite(value.tokens)
        ? Math.max(0, Math.round(value.tokens))
        : null;
  const percent =
    value.percent === null || value.percent === undefined
      ? tokens === null
        ? null
        : Math.min(100, Math.round((tokens / contextWindow) * 100))
      : Math.min(100, Math.max(0, Math.round(value.percent)));
  return { tokens, contextWindow, percent };
}

/** Compact token count for UI (e.g. 1.2k, 128k). */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
