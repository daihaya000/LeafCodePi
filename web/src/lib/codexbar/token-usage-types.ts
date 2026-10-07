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
  id: string;
  title: string;
  sampledTokens: number;
  sampledPercent: number;
  tokensPerPercent: number | null;
  estimatedRemainingTokens: number | null;
};

export type ProviderTokenUsage = TokenUsageTotals & {
  windows: TokenUsageEstimate[];
};
