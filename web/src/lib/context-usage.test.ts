import { describe, expect, it } from "vitest";
import { formatTokens, toContextUsageDto } from "./context-usage";

describe("context-usage", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(128_000)).toBe("128k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  it("normalizes Pi getContextUsage snapshots", () => {
    expect(
      toContextUsageDto({ tokens: 12_345.6, contextWindow: 128_000, percent: 9.64 }),
    ).toEqual({ tokens: 12346, contextWindow: 128000, percent: 10 });
    expect(toContextUsageDto({ tokens: null, contextWindow: 128000, percent: null })).toEqual({
      tokens: null,
      contextWindow: 128000,
      percent: null,
    });
    expect(toContextUsageDto({ tokens: 100, contextWindow: 0, percent: 1 })).toBeUndefined();
  });
});
