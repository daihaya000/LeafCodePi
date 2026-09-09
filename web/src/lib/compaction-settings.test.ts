import { describe, expect, it } from "vitest";
import {
  parseCompactionAction,
  reserveTokensForThreshold,
  shouldCompactAtThreshold,
} from "./compaction-settings";

describe("compaction settings", () => {
  it("defaults to auto-compaction when no action is stored", () => {
    expect(parseCompactionAction(null)).toBe("auto");
    expect(parseCompactionAction("unknown")).toBe("auto");
    expect(parseCompactionAction("suggest")).toBe("suggest");
    expect(parseCompactionAction("off")).toBe("off");
  });

  it("only auto-compacts at or above the configured threshold", () => {
    expect(shouldCompactAtThreshold("auto", 80, 80)).toBe(true);
    expect(shouldCompactAtThreshold("auto", 79.9, 80)).toBe(false);
    expect(shouldCompactAtThreshold("suggest", 95, 80)).toBe(false);
    expect(shouldCompactAtThreshold("off", 95, 80)).toBe(false);
    expect(shouldCompactAtThreshold("auto", null, 80)).toBe(false);
  });

  it("maps the threshold to Pi's reserve boundary", () => {
    expect(reserveTokensForThreshold(128_000, 80)).toBe(25_600);
    expect(reserveTokensForThreshold(128_000, 95)).toBe(6_400);
    expect(reserveTokensForThreshold(0, 80)).toBe(0);
  });
});
