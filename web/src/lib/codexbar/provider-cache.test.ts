import { afterEach, describe, expect, it } from "vitest";
import {
  clearProviderCache,
  getProviderCache,
  peekLastGood,
  setProviderCacheError,
  setProviderCacheOk,
  shouldSkipProviderFetch,
  _providerCacheSizeForTest,
} from "@/lib/codexbar/provider-cache";
import type { UsageSnapshot } from "@/lib/codexbar/types";

function snap(id = "claude"): UsageSnapshot {
  return {
    providerId: id,
    providerName: "Claude",
    plan: "Pro",
    accountEmail: null,
    windows: [
      {
        id: "claude-5h",
        title: "5時間",
        usedPercent: 42,
        resetsAt: null,
        windowDurationMs: 5 * 60 * 60 * 1000,
        countsTowardLimit: true,
      },
    ],
    creditsBalance: null,
    creditsLabel: null,
    creditsEnabled: false,
    creditsTitle: null,
    creditsUsed: null,
    creditsLimit: null,
    sourceLabel: "test",
    updatedAt: new Date("2026-08-21T00:00:00Z"),
    isStale: false,
    rateLimitResetCreditsAvailable: null,
  };
}

afterEach(() => {
  clearProviderCache();
});

describe("provider-cache", () => {
  it("serves success within TTL and skips force until expired", () => {
    const t0 = 1_000_000;
    setProviderCacheOk("claude", snap(), t0);
    expect(shouldSkipProviderFetch("claude", false, t0 + 60_000)?.kind).toBe(
      "ok",
    );
    expect(shouldSkipProviderFetch("claude", true, t0 + 60_000)).toBeNull();
    expect(
      shouldSkipProviderFetch("claude", false, t0 + 6 * 60_000),
    ).toBeNull();
  });

  it("blocks forceRefresh during rate-limit backoff and keeps lastGood", () => {
    const t0 = 2_000_000;
    setProviderCacheOk("claude", snap(), t0);
    setProviderCacheError("claude", "レート制限", true, t0 + 1000);
    expect(peekLastGood("claude")?.windows[0]?.usedPercent).toBe(42);

    const blocked = shouldSkipProviderFetch("claude", true, t0 + 60_000);
    expect(blocked?.kind).toBe("rate_limit");
    expect(blocked?.error).toMatch(/レート制限/);

    // Still blocked near 14 min; free after 15 min
    expect(
      shouldSkipProviderFetch("claude", true, t0 + 14 * 60_000),
    ).not.toBeNull();
    expect(
      shouldSkipProviderFetch("claude", true, t0 + 16 * 60_000),
    ).toBeNull();
  });

  it("expires soft errors sooner than rate limits", () => {
    const t0 = 3_000_000;
    setProviderCacheError("codex", "boom", false, t0);
    expect(getProviderCache("codex", t0 + 60_000)?.kind).toBe("error");
    expect(getProviderCache("codex", t0 + 3 * 60_000)).toBeNull();
  });

  it("clearProviderCache empties store", () => {
    setProviderCacheOk("a", snap("a"));
    setProviderCacheOk("b", snap("b"));
    expect(_providerCacheSizeForTest()).toBe(2);
    clearProviderCache("a");
    expect(_providerCacheSizeForTest()).toBe(1);
    clearProviderCache();
    expect(_providerCacheSizeForTest()).toBe(0);
  });
});
