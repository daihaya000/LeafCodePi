/**
 * In-memory usage cache (~5 minutes, matching CodexBarWin default RefreshMinutes).
 *
 * State lives on `globalThis`: Next.js bundles each route separately, so a
 * module-level variable would be duplicated per route and /api/models would
 * never see what the widget's /api/codexbar/usage fetch cached.
 */

import type { CodexBarUsage } from "@/lib/codexbar";

const TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  usage: CodexBarUsage;
  storedAt: number;
};

const store = globalThis as { __leafcodeCodexbarUsage?: CacheEntry | null };

export function getCachedUsage(
  nowMs = Date.now(),
  ttlMs: number = TTL_MS,
): CodexBarUsage | null {
  const entry = store.__leafcodeCodexbarUsage;
  if (!entry) return null;
  if (nowMs - entry.storedAt > ttlMs) {
    store.__leafcodeCodexbarUsage = null;
    return null;
  }
  return entry.usage;
}

export function setCachedUsage(usage: CodexBarUsage, nowMs = Date.now()): void {
  store.__leafcodeCodexbarUsage = { usage, storedAt: nowMs };
}

export function clearCachedUsage(): void {
  store.__leafcodeCodexbarUsage = null;
}

/** Soft clear: keep entry but mark expired so next non-force read refetches. */
export function invalidateCachedUsage(): void {
  if (store.__leafcodeCodexbarUsage) {
    store.__leafcodeCodexbarUsage = { ...store.__leafcodeCodexbarUsage, storedAt: 0 };
  }
}

export function cacheTtlMs(): number {
  return TTL_MS;
}
