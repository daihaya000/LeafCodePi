import { describe, expect, it } from "vitest";
import type { ModelOption } from "@/lib/types";
import { modelLimitReached, modelNearLimit } from "./ModelSelect";

function option(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    value: "anthropic::claude",
    label: "Claude",
    providerID: "anthropic",
    modelID: "claude",
    ...overrides,
  };
}

describe("modelNearLimit", () => {
  it("is false below 75%", () => {
    expect(modelNearLimit(option({ codexbarUsedPercent: 74 }))).toBe(false);
  });

  it("is true at 75% when not maxed", () => {
    expect(modelNearLimit(option({ codexbarUsedPercent: 75, codexbarMaxed: false }))).toBe(true);
  });

  it("is false when maxed (handled separately)", () => {
    expect(modelNearLimit(option({ codexbarUsedPercent: 100, codexbarMaxed: true }))).toBe(false);
  });
});

describe("modelLimitReached", () => {
  it("is true when codexbarMaxed is set", () => {
    expect(modelLimitReached(option({ codexbarMaxed: true }))).toBe(true);
  });

  it("is false when usage unknown", () => {
    expect(modelLimitReached(option())).toBe(false);
  });
});
