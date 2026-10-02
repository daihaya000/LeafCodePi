import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { clearCachedUsage, getCachedUsage, setCachedUsage } from "@/lib/codexbar/cache";
import type { CodexBarUsage } from "@/lib/codexbar";
import {
  __setRoutingUsageFetcherForTests,
  ensureFreshRoutingUsage,
  ROUTING_USAGE_FRESH_MS,
  ROUTING_USAGE_RETRY_COOLDOWN_MS,
} from "./routing-usage";

const usage = { providers: [], scope: { kind: "all", accountId: null } } as unknown as CodexBarUsage;

describe("ensureFreshRoutingUsage", () => {
  beforeEach(() => clearCachedUsage());
  afterEach(() => {
    __setRoutingUsageFetcherForTests(null);
    clearCachedUsage();
    vi.useRealTimers();
  });

  it("does not fetch while the cache is fresh", async () => {
    setCachedUsage(usage, Date.now());
    let calls = 0;
    __setRoutingUsageFetcherForTests(async () => {
      calls += 1;
    });
    assert.equal(await ensureFreshRoutingUsage(), true);
    assert.equal(calls, 0);
  });

  it("fetches server-side when no browser has populated the cache", async () => {
    let calls = 0;
    __setRoutingUsageFetcherForTests(async () => {
      calls += 1;
      setCachedUsage(usage, Date.now());
    });
    assert.equal(await ensureFreshRoutingUsage(), true);
    assert.equal(calls, 1);
  });

  it("refetches once the cache is older than the fresh window", async () => {
    const now = Date.now();
    setCachedUsage(usage, now - ROUTING_USAGE_FRESH_MS - 1_000);
    let calls = 0;
    __setRoutingUsageFetcherForTests(async () => {
      calls += 1;
      setCachedUsage(usage, Date.now());
    });
    assert.equal(await ensureFreshRoutingUsage(now), true);
    assert.equal(calls, 1);
  });

  it("survives fetch failures and backs off to avoid delaying every prompt", async () => {
    let calls = 0;
    __setRoutingUsageFetcherForTests(async () => {
      calls += 1;
      throw new Error("network down");
    });
    const now = Date.now();
    assert.equal(await ensureFreshRoutingUsage(now), false);
    assert.equal(await ensureFreshRoutingUsage(now + 1_000), false);
    assert.equal(calls, 1);
    assert.equal(
      await ensureFreshRoutingUsage(now + ROUTING_USAGE_RETRY_COOLDOWN_MS + 1),
      false,
    );
    assert.equal(calls, 2);
  });

  it("coalesces simultaneous routing decisions into one refresh", async () => {
    let finish!: () => void;
    let calls = 0;
    __setRoutingUsageFetcherForTests(() => {
      calls += 1;
      return new Promise<void>((resolve) => {
        finish = () => {
          setCachedUsage(usage);
          resolve();
        };
      });
    });
    const first = ensureFreshRoutingUsage();
    const second = ensureFreshRoutingUsage();
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    finish();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
  });

  it("shares refresh work across separately loaded route modules", async () => {
    let finish!: () => void;
    __setRoutingUsageFetcherForTests(() => new Promise<void>((resolve) => {
      finish = () => { setCachedUsage(usage); resolve(); };
    }));
    const first = ensureFreshRoutingUsage();
    await Promise.resolve();
    vi.resetModules();
    const anotherRoute = await import("./routing-usage");
    const second = anotherRoute.ensureFreshRoutingUsage();
    assert.equal(first, second);
    finish();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
  });

  it("backs off when a successful fetch produces no cacheable usage", async () => {
    let calls = 0;
    __setRoutingUsageFetcherForTests(async () => { calls += 1; });
    assert.equal(await ensureFreshRoutingUsage(), false);
    assert.equal(await ensureFreshRoutingUsage(), false);
    assert.equal(calls, 1);
  });

  it("uses a fresh late result even while the failure cooldown is active", async () => {
    __setRoutingUsageFetcherForTests(async () => { throw new Error("network down"); });
    assert.equal(await ensureFreshRoutingUsage(), false);
    setCachedUsage(usage);
    assert.equal(await ensureFreshRoutingUsage(), true);
  });

  it("keeps the last-known snapshot when the refresh fails", async () => {
    const now = Date.now();
    setCachedUsage(usage, now - ROUTING_USAGE_FRESH_MS - 60_000);
    __setRoutingUsageFetcherForTests(async () => {
      throw new Error("network down");
    });
    assert.equal(await ensureFreshRoutingUsage(now), false);
    // 鮮度確認が期限切れ要素を消すと、30 分 last-known の順位付けまで失われる。
    assert.ok(getCachedUsage(now, 30 * 60 * 1000));
  });

  it("handles a late rejection after a timeout without an unhandled rejection", async () => {
    vi.useFakeTimers();
    let rejectFetch!: (error: Error) => void;
    __setRoutingUsageFetcherForTests(() => new Promise((_, reject) => { rejectFetch = reject; }));
    const attempt = ensureFreshRoutingUsage(Date.now(), 30);
    await vi.advanceTimersByTimeAsync(30);
    assert.equal(await attempt, false);
    rejectFetch(new Error("late network failure"));
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(vi.getTimerCount(), 0);
  });

  it("gives up after the timeout instead of blocking routing", async () => {
    __setRoutingUsageFetcherForTests(() => new Promise(() => undefined));
    vi.useFakeTimers();
    const attempt = ensureFreshRoutingUsage(Date.now(), 30);
    await vi.advanceTimersByTimeAsync(30);
    assert.equal(await attempt, false);
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(await ensureFreshRoutingUsage(), false);
  });
});
