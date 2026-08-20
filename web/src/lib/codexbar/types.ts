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
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
  }
}
