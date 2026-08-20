/**
 * Per-provider usage result cache + 429 backoff.
 * Prevents hammering Claude/other usage APIs when the aggregate cache is cold
 * or multiple requests race (Strict Mode / multi-tab).
 */

import type { UsageSnapshot } from "@/lib/codexbar/types";

const SUCCESS_TTL_MS = 5 * 60 * 1000;
const ERROR_TTL_MS = 2 * 60 * 1000;
/** Claude usage API is strict; back off longer after 429. */
const RATE_LIMIT_TTL_MS = 15 * 60 * 1000;

export type CachedProviderKind = "ok" | "error" | "rate_limit";

export type CachedProviderResult = {
  kind: CachedProviderKind;
  snapshot: UsageSnapshot | null;
  /** Last successful snapshot kept across rate-limit/error for stale display. */
  lastGood: UsageSnapshot | null;
  error: string | null;
  storedAt: number;
  ttlMs: number;
};

const store = new Map<string, CachedProviderResult>();

export function providerCacheTtlMs(kind: CachedProviderKind): number {
  switch (kind) {
    case "rate_limit":
      return RATE_LIMIT_TTL_MS;
    case "error":
      return ERROR_TTL_MS;
    default:
      return SUCCESS_TTL_MS;
  }
}

function isFresh(entry: CachedProviderResult, nowMs: number): boolean {
  return nowMs - entry.storedAt <= entry.ttlMs;
}

export function getProviderCache(
  id: string,
  nowMs = Date.now(),
): CachedProviderResult | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (!isFresh(entry, nowMs)) return null;
  return entry;
}

export function peekLastGood(id: string): UsageSnapshot | null {
  return store.get(id)?.lastGood ?? null;
}

/**
 * Whether a live network fetch should be skipped.
 * Rate-limit entries block even forceRefresh until TTL expires.
 */
export function shouldSkipProviderFetch(
  id: string,
  forceRefresh: boolean,
  nowMs = Date.now(),
): CachedProviderResult | null {
  const entry = getProviderCache(id, nowMs);
  if (!entry) return null;
  if (entry.kind === "rate_limit") return entry;
  if (!forceRefresh) return entry;
  return null;
}

export function setProviderCacheOk(
  id: string,
  snapshot: UsageSnapshot,
  nowMs = Date.now(),
): void {
  store.set(id, {
    kind: "ok",
    snapshot,
    lastGood: snapshot,
    error: null,
    storedAt: nowMs,
    ttlMs: SUCCESS_TTL_MS,
  });
}

export function setProviderCacheError(
  id: string,
  error: string,
  rateLimited: boolean,
  nowMs = Date.now(),
): void {
  const prev = store.get(id);
  const lastGood = prev?.lastGood ?? null;
  store.set(id, {
    kind: rateLimited ? "rate_limit" : "error",
    snapshot: null,
    lastGood,
    error,
    storedAt: nowMs,
    ttlMs: rateLimited ? RATE_LIMIT_TTL_MS : ERROR_TTL_MS,
  });
}

export function clearProviderCache(id?: string): void {
  if (id) store.delete(id);
  else store.clear();
}

/** Test helper. */
export function _providerCacheSizeForTest(): number {
  return store.size;
}
