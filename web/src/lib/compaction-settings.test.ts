import { describe, expect, it } from "vitest";
import {
  parseCacheWarmingMode,
  parseCompactionAction,
  parseCompactionThreshold,
  reserveTokensForThreshold,
  shouldCompactAtThreshold,
  shouldSuggestAtThreshold,
} from "./compaction-settings";

describe("compaction settings", () => {
  it("accepts only Pi's cache-warming modes", () => {
    expect(parseCacheWarmingMode("off")).toBe("off");
    expect(parseCacheWarmingMode("streaming")).toBe("streaming");
    expect(parseCacheWarmingMode("idle")).toBe("idle");
    expect(parseCacheWarmingMode("unknown")).toBeNull();
  });

  it("defaults to auto-compaction when no action is stored", () => {
    expect(parseCompactionAction(null)).toBe("auto");
    expect(parseCompactionAction("unknown")).toBe("auto");
    expect(parseCompactionAction("suggest")).toBe("suggest");
    expect(parseCompactionAction("off")).toBe("off");
  });

  it("defaults the threshold to 95% when unset or invalid", () => {
    expect(parseCompactionThreshold(null)).toBe(95);
    expect(parseCompactionThreshold("50")).toBe(95);
    expect(parseCompactionThreshold("80")).toBe(80);
  });

  it("only auto-compacts at or above the configured threshold", () => {
    expect(shouldCompactAtThreshold("auto", 80, 80)).toBe(true);
    expect(shouldCompactAtThreshold("auto", 79.9, 80)).toBe(false);
    expect(shouldCompactAtThreshold("suggest", 95, 80)).toBe(false);
    expect(shouldCompactAtThreshold("off", 95, 80)).toBe(false);
    expect(shouldCompactAtThreshold("auto", null, 80)).toBe(false);
  });

  it("suggests compaction only for the suggest action at the threshold", () => {
    expect(shouldSuggestAtThreshold("suggest", 80, 80)).toBe(true);
    expect(shouldSuggestAtThreshold("suggest", 79.9, 80)).toBe(false);
    expect(shouldSuggestAtThreshold("auto", 95, 80)).toBe(false);
    expect(shouldSuggestAtThreshold("off", 95, 80)).toBe(false);
    expect(shouldSuggestAtThreshold("suggest", null, 80)).toBe(false);
  });

  it("maps the threshold to Pi's reserve boundary", () => {
    expect(reserveTokensForThreshold(128_000, 80)).toBe(25_600);
    expect(reserveTokensForThreshold(0, 80)).toBe(0);
  });

  it("keeps 10% headroom so one turn of large tool results cannot overshoot", () => {
    expect(reserveTokensForThreshold(128_000, 95)).toBe(12_800);
    expect(reserveTokensForThreshold(272_000, 95)).toBe(27_200);
  });
});
