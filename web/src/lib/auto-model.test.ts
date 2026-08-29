import { describe, expect, it } from "vitest";
import {
  AUTO_MODEL_VALUE,
  chooseAutoModel,
  classifyPrompt,
  modelCostTier,
  type AutoCandidateProvider,
} from "@/lib/auto-model";
import type { ModelOption } from "@/lib/types";

function model(
  modelID: string,
  overrides: Partial<ModelOption> = {},
): ModelOption {
  return {
    value: `provider::${modelID}`,
    label: modelID,
    providerID: "provider",
    modelID,
    ...overrides,
  };
}

describe("classifyPrompt", () => {
  it("uses deterministic light/standard/heavy boundaries", () => {
    expect(classifyPrompt("なぜこうなるの")).toBe("light");
    expect(classifyPrompt("この関数を修正して")).toBe("standard");
    expect(classifyPrompt("リファクタして")).toBe("heavy");
    expect(classifyPrompt("あ".repeat(1_501))).toBe("heavy");
  });

  it("keeps the exact length boundaries and code-fence rule stable", () => {
    expect(classifyPrompt(`なぜ${"あ".repeat(197)}`)).toBe("light");
    expect(classifyPrompt(`なぜ${"あ".repeat(198)}`)).toBe("standard");
    expect(classifyPrompt("あ".repeat(1_500))).toBe("standard");
    expect(classifyPrompt("あ".repeat(1_501))).toBe("heavy");
    expect(classifyPrompt("これは何ですか\n```\nconst value = 1;\n```")).toBe(
      "standard",
    );
    expect(
      classifyPrompt("```\nconst a = 1;\n```\n```\nconst b = 2;\n```"),
    ).toBe("heavy");
  });

  it("does not classify mixed questions and work instructions as light", () => {
    expect(classifyPrompt("なぜ壊れるか調べて修正して")).toBe("standard");
    expect(classifyPrompt("")).toBe("standard");
    expect(classifyPrompt("   \n\t ")).toBe("standard");
  });

  it("does not let images change the text tier", () => {
    expect(classifyPrompt("なぜこうなるの", { hasImages: true })).toBe("light");
    expect(classifyPrompt("なぜこうなるの", { hasImages: false, historyMessageCount: 20 })).toBe(
      "standard",
    );
  });
});

describe("chooseAutoModel", () => {
  it("selects the best cheap model for a short question and escalates once", () => {
    const decision = chooseAutoModel({
      models: [
        model("claude-haiku-4-5", { thinkingLevels: ["minimal", "low"] }),
        model("claude-opus-5", { thinkingLevels: ["medium", "high"] }),
      ],
      tier: "light",
      hasImages: false,
    });
    expect(decision).toMatchObject({
      providerID: "provider",
      modelID: "claude-haiku-4-5",
      variant: "minimal",
      escalation: { modelID: "claude-opus-5" },
    });
  });

  it("filters disabled and image-incompatible candidates", () => {
    const decision = chooseAutoModel({
      models: [
        model("flash", { input: ["text"] }),
        model("sonnet", { input: ["text", "image"] }),
      ],
      disabled: { "provider::sonnet": true },
      tier: "light",
      hasImages: true,
    });
    expect(decision).toBeNull();
  });

  it("falls back by cost band and reports the fallback", () => {
    const decision = chooseAutoModel({
      models: [model("claude-sonnet-5")],
      tier: "light",
      hasImages: false,
    });
    expect(decision).toMatchObject({
      modelID: "claude-sonnet-5",
      reason: expect.stringContaining("フォールバック"),
    });
  });

  it("uses deterministic lexical ordering for equal scores", () => {
    const decision = chooseAutoModel({
      providers: [
        { id: "zeta", models: { model: {} } },
        { id: "alpha", models: { model: {} } },
      ],
      tier: "heavy",
      hasImages: false,
    });
    expect(decision).toMatchObject({ providerID: "alpha", modelID: "model" });
  });

  it("ignores disabled provider variants and chooses an escalation target", () => {
    const decision = chooseAutoModel({
      providers: [
        {
          id: "alpha",
          models: {
            "claude-haiku-4-5": {
              variants: { minimal: { disabled: true }, low: {} },
            },
          },
        },
        {
          id: "beta",
          models: {
            "claude-opus-5": { variants: { high: {}, max: {} } },
          },
        },
      ],
      tier: "light",
      hasImages: false,
    });
    expect(decision).toMatchObject({
      modelID: "claude-haiku-4-5",
      variant: "low",
      escalation: { providerID: "beta", modelID: "claude-opus-5", variant: "high" },
    });
  });

  it("supports the provider-shaped upstream input", () => {
    const providers: AutoCandidateProvider[] = [
      {
        id: "alpha",
        models: {
          "claude-haiku-4-5": { variants: { minimal: {} } },
        },
      },
    ];
    expect(
      chooseAutoModel({
        providers,
        tier: "light",
        hasImages: false,
      }),
    ).toMatchObject({ providerID: "alpha", modelID: "claude-haiku-4-5" });
  });

  it("keeps Auto separate from concrete model values", () => {
    expect(AUTO_MODEL_VALUE).toBe("auto");
    expect(AUTO_MODEL_VALUE).not.toContain("::");
    expect(modelCostTier("gpt_5_6_sol")).toBe("premium");
  });
});
