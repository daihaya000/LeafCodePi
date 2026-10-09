/** Client-safe, additive telemetry. These are observed tokens, not a contractual quota. */
export type TokenUsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  responses: number;
  startedAt: string | null;
};

export type TokenUsageEstimate = {
  /** Optional for compatibility with older API snapshots. */
  status?: "calibrating" | "ready" | "stale" | "expired" | "unsupported" | "invalid";
  /** Earlier of upstream freshness expiry and quota reset. */
  validUntil?: string | null;
  id: string;
  title: string;
  sampledTokens: number;
  sampledPercent: number;
  tokensPerPercent: number | null;
  estimatedRemainingTokens: number | null;
  /** Display-only sum of independent account capacities; otherwise rate × 100. */
  estimatedTotalTokens?: number | null;
};

export type ProviderTokenUsage = TokenUsageTotals & {
  windows: TokenUsageEstimate[];
};
