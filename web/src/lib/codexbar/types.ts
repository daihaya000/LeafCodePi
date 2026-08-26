/**
 * Internal usage types (server-only). Mirrors CodexBarWin UsageSnapshot / RateWindow.
 */

export type RateWindow = {
  id: string;
  title: string;
  usedPercent: number;
  resetsAt: Date | null;
  /** Window length; null when unknown. */
  windowDurationMs: number | null;
  /**
   * True when this window drives the provider aggregate.
   * False for breakdown sub-windows (e.g. Cursor Auto/API under プラン).
   */
  countsTowardLimit: boolean;
};

export type UsageScope = {
  key: string;
  kind: "default" | "account";
  accountId: string | null;
  accountLabel: string | null;
  /** Server-only resolved Pi auth path. Never serialize this. */
  authPath: string | null;
};

export type UsageProviderDefinition = {
  id: string;
  name: string;
  kind: "shared" | "subscription";
  create(scope: UsageScope): IUsageProvider;
};

export type UsageProviderInstance = IUsageProvider & {
  instanceId: string;
  accountId: string | null;
  accountLabel: string | null;
  scope: UsageScope;
};

export type UsageSnapshot = {
  providerId: string;
  providerName: string;
  plan: string | null;
  accountEmail: string | null;
  windows: RateWindow[];
  creditsBalance: number | null;
  creditsLabel: string | null;
  creditsEnabled: boolean;
  creditsTitle: string | null;
  creditsUsed: number | null;
  creditsLimit: number | null;
  sourceLabel: string | null;
  updatedAt: Date;
  isStale: boolean;
};

export type ProviderFetchResult = {
  id: string;
  name: string;
  instanceId: string;
  accountId: string | null;
  accountLabel: string | null;
  configured: boolean;
  snapshot: UsageSnapshot | null;
  error: string | null;
};

export interface IUsageProvider {
  readonly id: string;
  readonly name: string;
  isConfigured(): boolean;
  fetch(signal?: AbortSignal): Promise<UsageSnapshot>;
}

export class ProviderError extends Error {
  /** e.g. `rate_limit` — orchestrator backs off without re-hitting the API. */
  readonly code: string | null;

  constructor(
    message: string,
    options?: { cause?: unknown; code?: string | null },
  ) {
    super(message, options);
    this.name = "ProviderError";
    this.code = options?.code ?? null;
  }

  get isRateLimit(): boolean {
    return this.code === "rate_limit";
  }
}
