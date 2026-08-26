/**
 * In-memory usage cache (~5 minutes, matching CodexBarWin default RefreshMinutes).
 *
 * State lives on `globalThis`: Next.js bundles each route separately, so a
 * module-level variable would be duplicated per route and /api/models would
 * never see what the widget's /api/codexbar/usage fetch cached.
 */

import type { CodexBarUsage } from "@/lib/codexbar";

const TTL_MS = 5 * 60 * 1000;
const CACHE_KEY = "__leafcodeCodexbarUsageCache";
const LATEST_ALL_KEY = "__leafcodeCodexbarLatestAllKey";

type CacheEntry = {
  usage: CodexBarUsage;
  storedAt: number;
};

type GlobalCache = typeof globalThis & {
  [CACHE_KEY]?: Map<string, CacheEntry>;
  [LATEST_ALL_KEY]?: string;
};

function cacheStore(): Map<string, CacheEntry> {
  const globalRef = globalThis as GlobalCache;
  if (!globalRef[CACHE_KEY]) globalRef[CACHE_KEY] = new Map();
  return globalRef[CACHE_KEY]!;
}

export function getCachedUsageForKey(
  key: string,
  nowMs = Date.now(),
  ttlMs: number = TTL_MS,
): CodexBarUsage | null {
  const store = cacheStore();
  const entry = store.get(key);
  if (!entry) return null;
  if (nowMs - entry.storedAt > ttlMs) {
    store.delete(key);
    return null;
  }
  return entry.usage;
}

/** Read the latest all-scope snapshot for /api/models and legacy callers. */
export function getCachedUsage(
  nowMs = Date.now(),
  ttlMs: number = TTL_MS,
): CodexBarUsage | null {
  const globalRef = globalThis as GlobalCache;
  const key = globalRef[LATEST_ALL_KEY] ?? "all";
  return getCachedUsageForKey(key, nowMs, ttlMs);
}

export function setCachedUsage(
  usage: CodexBarUsage,
  nowMs = Date.now(),
  key?: string,
): void {
  const cacheKey = key ?? "all";
  const store = cacheStore();
  if (usage.scope?.kind === "all" || cacheKey === "all" || cacheKey.startsWith("all:")) {
    const globalRef = globalThis as GlobalCache;
    const previous = globalRef[LATEST_ALL_KEY];
    if (previous && previous !== cacheKey) store.delete(previous);
    globalRef[LATEST_ALL_KEY] = cacheKey;
  }
  store.set(cacheKey, { usage, storedAt: nowMs });
}

export function clearCachedUsage(key?: string): void {
  const globalRef = globalThis as GlobalCache;
  const store = cacheStore();
  if (key) {
    store.delete(key);
    if (globalRef[LATEST_ALL_KEY] === key) delete globalRef[LATEST_ALL_KEY];
    return;
  }
  store.clear();
  delete globalRef[LATEST_ALL_KEY];
}

/** Soft clear: keep entries but mark them expired so next non-force read refetches. */
export function invalidateCachedUsage(): void {
  const store = cacheStore();
  for (const [key, entry] of store) {
    store.set(key, { ...entry, storedAt: 0 });
  }
}

export function cacheTtlMs(): number {
  return TTL_MS;
}
