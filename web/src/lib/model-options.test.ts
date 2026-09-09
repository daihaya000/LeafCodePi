import { describe, expect, it } from "vitest";
import { modelIntelligenceScore } from "./model-options";

describe("modelIntelligenceScore", () => {
  it("does not treat the date suffix of a Claude model id as a version", () => {
    const dated = modelIntelligenceScore("claude-sonnet-4-20250514");
    // 修正前は日付がバージョン小数部になり +2 億スコアになっていた
    expect(dated).toBeLessThan(1_000_000);
    expect(dated).toBe(modelIntelligenceScore("claude-sonnet-4"));
  });

  it("ranks families and tiers consistently", () => {
    expect(modelIntelligenceScore("claude-opus-4-1")).toBeGreaterThan(
      modelIntelligenceScore("claude-sonnet-4"),
    );
    expect(modelIntelligenceScore("claude-sonnet-4")).toBeGreaterThan(
      modelIntelligenceScore("claude-haiku-4"),
    );
    expect(modelIntelligenceScore("gpt-4o")).toBeGreaterThan(
      modelIntelligenceScore("gpt-4o-mini"),
    );
    expect(modelIntelligenceScore("o3")).toBeGreaterThan(
      modelIntelligenceScore("o3-mini"),
    );
  });

  it("adds version digits", () => {
    expect(modelIntelligenceScore("gpt-4.1")).toBeGreaterThan(
      modelIntelligenceScore("gpt-4"),
    );
    expect(modelIntelligenceScore("claude-sonnet-4-5")).toBeGreaterThan(
      modelIntelligenceScore("claude-sonnet-4"),
    );
  });

  it("normalizes casing", () => {
    expect(modelIntelligenceScore("CLAUDE-3-5-SONNET")).toBe(
      modelIntelligenceScore("claude-3-5-sonnet"),
    );
    expect(modelIntelligenceScore("GPT-4O")).toBe(
      modelIntelligenceScore("gpt-4o"),
    );
  });
});