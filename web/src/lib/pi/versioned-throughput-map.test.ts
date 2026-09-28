import { describe, expect, it } from "vitest";
import { createThroughputTiming } from "@/lib/token-throughput";
import { VersionedThroughputMap } from "./versioned-throughput-map";

describe("VersionedThroughputMap", () => {
  it("tracks same-key updates and rows that still depend on the clock", () => {
    const pending = createThroughputTiming(1_000);
    const finalized = { ...createThroughputTiming(2_000), lastTokenAtMs: 2_500 };
    const timings = new VersionedThroughputMap([[1_000, pending], [2_000, finalized]]);
    expect(timings.revision).toBe(0);
    expect(timings.awaitingFirstTokenCount).toBe(1);

    timings.set(1_000, { ...pending, lastTokenAtMs: 1_500 });
    expect(timings.size).toBe(2);
    expect(timings.revision).toBe(1);
    expect(timings.awaitingFirstTokenCount).toBe(0);
    timings.set(2_000, { ...finalized, lastTokenAtMs: null });
    expect(timings.revision).toBe(2);
    expect(timings.awaitingFirstTokenCount).toBe(1);

    expect(timings.delete(1_000)).toBe(true);
    expect(timings.awaitingFirstTokenCount).toBe(1);
    expect(timings.delete(2_000)).toBe(true);
    expect(timings.awaitingFirstTokenCount).toBe(0);
    expect(timings.revision).toBe(4);
    expect(timings.delete(2_000)).toBe(false);
    expect(timings.revision).toBe(4);
    timings.set(3_000, pending);
    timings.clear();
    expect(timings.awaitingFirstTokenCount).toBe(0);
    expect(timings.revision).toBe(6);
    timings.clear();
    expect(timings.revision).toBe(6);
  });

  it("handles duplicate restored keys without a stale pending count", () => {
    const pending = createThroughputTiming(1_000);
    const finalized = { ...pending, lastTokenAtMs: 1_500 };
    const timings = new VersionedThroughputMap([[1_000, pending], [1_000, finalized]]);
    expect(timings.size).toBe(1);
    expect(timings.revision).toBe(0);
    expect(timings.awaitingFirstTokenCount).toBe(0);
  });
});
