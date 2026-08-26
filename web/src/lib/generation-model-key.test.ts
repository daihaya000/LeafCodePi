import { describe, expect, it } from "vitest";
import { splitGenerationModel } from "./generation-model-key";

describe("splitGenerationModel", () => {
  it("keeps legacy provider/model values compatible", () => {
    expect(splitGenerationModel("anthropic::claude-sonnet", ["acc-1"])).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet",
    });
  });

  it("parses an account prefix only for a known account", () => {
    expect(splitGenerationModel("acc-1::anthropic::claude-sonnet", ["acc-1"])).toEqual({
      accountId: "acc-1",
      providerID: "anthropic",
      modelID: "claude-sonnet",
    });
    expect(splitGenerationModel("unknown::anthropic::claude-sonnet", ["acc-1"])).toEqual({
      providerID: "unknown",
      modelID: "anthropic::claude-sonnet",
    });
  });
});
