/**
 * In-memory usage cache (~5 minutes, matching CodexBarWin default RefreshMinutes).
 */

import type { CodexBarUsage } from "@/lib/codexbar";

const TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  usage: CodexBarUsage;
  storedAt: number;
};

let entry: CacheEntry | null = null;

export function getCachedUsage(
  nowMs = Date.now(),
  ttlMs: number = TTL_MS,
): CodexBarUsage | null {
  if (!entry) return null;
  if (nowMs - entry.storedAt > ttlMs) {
    entry = null;
    return null;
  }
  return entry.usage;
}

export function setCachedUsage(usage: CodexBarUsage, nowMs = Date.now()): void {
  entry = { usage, storedAt: nowMs };
}

export function clearCachedUsage(): void {
  entry = null;
}

/** Soft clear: keep entry but mark expired so next non-force read refetches. */
export function invalidateCachedUsage(): void {
  if (entry) entry = { ...entry, storedAt: 0 };
}

export function cacheTtlMs(): number {
  return TTL_MS;
}
