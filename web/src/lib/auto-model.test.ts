import { describe, expect, it } from "vitest";
import {
  AUTO_MODEL_VALUE,
  autoProviderUsageFromProviders,
  autoProviderUsageFromModels,
  autoModelValue,
  autoVariantToThinkingLevel,
  chooseAutoModel,
  classifyPrompt,
  formatAutoDecisionNotice,
  modelCostTier,
  normalizeAutoRouteConfig,
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

  it("keeps the history and attachment thresholds exact", () => {
    // SIGNAL_HISTORY_THRESHOLD = 20, SIGNAL_ATTACHMENT_THRESHOLD = 3
    expect(
      classifyPrompt("なぜこうなるの", { hasImages: false, historyMessageCount: 19 }),
    ).toBe("light");
    expect(
      classifyPrompt("なぜこうなるの", { hasImages: false, historyMessageCount: 20 }),
    ).toBe("standard");
    expect(
      classifyPrompt("なぜこうなるの", { hasImages: false, attachmentCount: 2 }),
    ).toBe("light");
    expect(
      classifyPrompt("なぜこうなるの", { hasImages: false, attachmentCount: 3 }),
    ).toBe("standard");
  });

  it("escalates on a recent failure and saturates at heavy", () => {
    expect(
      classifyPrompt("なぜこうなるの", { hasImages: false, recentFailure: true }),
    ).toBe("standard");
    // light -> standard, standard -> heavy, heavy stays heavy (no overflow).
    expect(
      classifyPrompt("この関数を修正して", { hasImages: false, recentFailure: true }),
    ).toBe("heavy");
    expect(
      classifyPrompt("リファクタして", { hasImages: false, recentFailure: true }),
    ).toBe("heavy");
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

  it("applies the selected optimization mode to the preset route", () => {
    const models = [
      model("claude-haiku-4-5", { thinkingLevels: ["minimal"] }),
      model("claude-sonnet-5", { thinkingLevels: ["medium"] }),
    ];
    expect(
      chooseAutoModel({ models, tier: "light", hasImages: false, mode: "balanced" }),
    ).toMatchObject({ modelID: "claude-haiku-4-5", mode: "balanced" });
    expect(
      chooseAutoModel({ models, tier: "light", hasImages: false, mode: "intelligence" }),
    ).toMatchObject({ modelID: "claude-sonnet-5", mode: "intelligence" });
  });

  it("reroutes a best-cost choice when another provider has a lower usage gap", () => {
    const decision = chooseAutoModel({
      models: [
        model("claude-haiku-4-5", { providerID: "alpha", value: "alpha::haiku" }),
        model("claude-haiku-4-5", { providerID: "beta", value: "beta::haiku" }),
      ],
      tier: "light",
      hasImages: false,
      usage: {
        alpha: { usedPercent: 90, limited: false },
        beta: { usedPercent: 70, limited: false },
      },
    });
    expect(decision).toMatchObject({ providerID: "beta", modelID: "claude-haiku-4-5" });
  });

  it("skips a limited configured provider and preserves account usage keys", () => {
    const usage = autoProviderUsageFromModels([
      model("claude-haiku-4-5", {
        providerID: "provider",
        accountId: "account-a",
        codexbarUsedPercent: 90,
      }),
      model("claude-haiku-4-5", {
        providerID: "provider",
        accountId: "account-a",
        codexbarMaxed: true,
      }),
    ]);
    expect(usage).toEqual({
      "account-a::provider::claude-haiku-4-5": {
        usedPercent: 90,
        limited: true,
      },
    });

    const accountDecision = chooseAutoModel({
      models: [
        model("claude-haiku-4-5", {
          providerID: "provider",
          value: "account-a::provider::haiku",
          accountId: "account-a",
        }),
        model("claude-haiku-4-5", {
          providerID: "provider",
          value: "account-b::provider::haiku",
          accountId: "account-b",
        }),
      ],
      tier: "light",
      hasImages: false,
      config: {
        version: 2,
        modes: {
          cost: {
            light: {
              candidates: [
                { kind: "model", providerID: "provider", modelID: "claude-haiku-4-5" },
              ],
            },
          },
        },
      },
      usage: {
        "account-a::provider": { usedPercent: 100, limited: true },
        "account-b::provider": { usedPercent: 10, limited: false },
      },
    });
    expect(accountDecision).toMatchObject({ accountId: "account-b" });

    const modelScopedUsage = autoProviderUsageFromModels([
      model("claude-haiku-4-5", {
        providerID: "provider",
        codexbarMaxed: true,
      }),
      model("claude-sonnet-5", {
        providerID: "provider",
        codexbarUsedPercent: 10,
      }),
    ]);
    const modelScopedDecision = chooseAutoModel({
      models: [
        model("claude-haiku-4-5", { providerID: "provider" }),
        model("claude-sonnet-5", { providerID: "provider" }),
      ],
      tier: "light",
      hasImages: false,
      usage: modelScopedUsage,
      config: {
        version: 2,
        modes: {
          cost: {
            light: {
              candidates: [
                { kind: "model", providerID: "provider", modelID: "claude-haiku-4-5" },
                { kind: "model", providerID: "provider", modelID: "claude-sonnet-5" },
              ],
            },
          },
        },
      },
    });
    expect(modelScopedDecision).toMatchObject({
      providerID: "provider",
      modelID: "claude-sonnet-5",
      candidateIndex: 1,
    });

    const decision = chooseAutoModel({
      models: [
        model("claude-haiku-4-5", { providerID: "alpha", value: "alpha::haiku" }),
        model("claude-haiku-4-5", { providerID: "beta", value: "beta::haiku" }),
      ],
      tier: "light",
      hasImages: false,
      config: {
        version: 2,
        modes: {
          cost: {
            light: {
              candidates: [
                { kind: "model", providerID: "alpha", modelID: "claude-haiku-4-5" },
                { kind: "model", providerID: "beta", modelID: "claude-haiku-4-5" },
              ],
            },
          },
        },
      },
      usage: {
        alpha: { usedPercent: 100, limited: true },
        beta: { usedPercent: 10, limited: false },
      },
    });
    expect(decision).toMatchObject({
      providerID: "beta",
      candidateIndex: 1,
    });
  });

  it("does not let stale or invalid usage hide an otherwise usable model", () => {
    const usage = autoProviderUsageFromProviders([
      { id: "invalid", usedPercent: Number.NaN },
      { id: "explicit-limit", usedPercent: 10, limited: true },
      { id: "provider", usedPercent: 100, maxed: true, stale: true },
    ]);
    expect(usage).toEqual({
      "explicit-limit": { usedPercent: 10, limited: true },
      provider: { usedPercent: 100, limited: true, stale: true },
    });

    const decision = chooseAutoModel({
      models: [model("claude-haiku-4-5")],
      tier: "light",
      hasImages: false,
      usage,
    });
    expect(decision).toMatchObject({ modelID: "claude-haiku-4-5" });

    const limitedDecision = chooseAutoModel({
      models: [
        model("claude-haiku-4-5", {
          providerID: "explicit-limit",
          value: "explicit-limit::haiku",
        }),
        model("claude-haiku-4-5", {
          providerID: "available",
          value: "available::haiku",
        }),
      ],
      tier: "light",
      hasImages: false,
      usage,
      config: {
        version: 2,
        modes: {
          cost: {
            light: {
              candidates: [
                { kind: "model", providerID: "explicit-limit", modelID: "claude-haiku-4-5" },
                { kind: "model", providerID: "available", modelID: "claude-haiku-4-5" },
              ],
            },
          },
        },
      },
    });
    expect(limitedDecision).toMatchObject({ providerID: "available", candidateIndex: 1 });
  });

  it("resolves v2 candidates in order and skips unavailable models", () => {
    const decision = chooseAutoModel({
      models: [model("claude-sonnet-5", { thinkingLevels: ["high"] })],
      tier: "light",
      hasImages: false,
      mode: "cost",
      config: {
        version: 2,
        modes: {
          cost: {
            light: {
              candidates: [
                { kind: "model", providerID: "provider", modelID: "missing" },
                { kind: "model", providerID: "provider", modelID: "claude-sonnet-5", variant: "high" },
              ],
            },
          },
        },
      },
    });
    expect(decision).toMatchObject({
      modelID: "claude-sonnet-5",
      variant: "high",
      candidateIndex: 1,
    });
    expect(decision?.reason).toContain("候補1〜1は利用不可");
  });

  it("uses a manually configured balanced model and effort for each tier", () => {
    const models = [
      model("gpt-5.6-luna", {
        providerID: "openai-codex",
        value: "openai-codex::gpt-5.6-luna",
        thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
      }),
      model("gpt-5.6-sol", {
        providerID: "openai-codex",
        value: "openai-codex::gpt-5.6-sol",
        thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
      }),
    ];
    const config = {
      version: 2 as const,
      modes: {
        balanced: {
          light: {
            candidates: [
              {
                kind: "model" as const,
                providerID: "openai-codex",
                modelID: "gpt-5.6-luna",
                variant: "max" as const,
              },
            ],
          },
          heavy: {
            candidates: [
              {
                kind: "model" as const,
                providerID: "openai-codex",
                modelID: "gpt-5.6-sol",
                variant: "medium" as const,
              },
            ],
          },
        },
      },
    };

    expect(
      chooseAutoModel({ models, tier: "light", hasImages: false, mode: "balanced", config }),
    ).toMatchObject({ modelID: "gpt-5.6-luna", variant: "max", mode: "balanced" });
    expect(
      chooseAutoModel({ models, tier: "heavy", hasImages: false, mode: "balanced", config }),
    ).toMatchObject({ modelID: "gpt-5.6-sol", variant: "medium", mode: "balanced" });
  });

  it("migrates legacy route overrides to all v2 modes", () => {
    const config = normalizeAutoRouteConfig({
      light: { costOrder: null, variantOrder: ["high"] },
    });
    expect(config.version).toBe(2);
    for (const mode of ["cost", "balanced", "intelligence"] as const) {
      expect(config.modes[mode]?.light).toEqual({
        candidates: [{ kind: "strongest" }],
        variantFallbackOrder: ["high"],
      });
    }
  });

  it("does not persist a fallback-only empty route as an override", () => {
    expect(
      normalizeAutoRouteConfig({
        version: 2,
        modes: { cost: { light: { candidates: [], fallback: "error" } } },
      }),
    ).toEqual({ version: 2, modes: {} });
  });

  it("can hide the selected model from the decision notice", () => {
    const decision = chooseAutoModel({
      models: [model("claude-haiku-4-5")],
      tier: "light",
      hasImages: false,
    });
    expect(decision).not.toBeNull();
    const notice = formatAutoDecisionNotice(decision!, { showModel: false });
    expect(notice).not.toContain("claude-haiku-4-5");
    expect(notice).toContain("モデルを自動選択");
  });

  it("keeps Auto separate from concrete model values", () => {
    expect(AUTO_MODEL_VALUE).toBe("auto");
    expect(AUTO_MODEL_VALUE).not.toContain("::");
    expect(modelCostTier("gpt_5_6_sol")).toBe("premium");
  });

  it("maps Auto variants to Pi thinking levels", () => {
    // Effort levels Pi understands.
    for (const variant of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(autoVariantToThinkingLevel(variant)).toBe(variant);
    }
    expect(autoVariantToThinkingLevel("off")).toBe("off");
    // "none", "" and the provider-only "thinking" have no ThinkingLevel equivalent,
    // so they must yield undefined and let the provider default apply.
    for (const variant of ["none", "", "thinking"] as const) {
      expect(autoVariantToThinkingLevel(variant)).toBeUndefined();
    }
    // Unknown values must not leak through.
    expect(autoVariantToThinkingLevel("bogus" as never)).toBeUndefined();
  });

  it("builds the model value with and without an account", () => {
    expect(autoModelValue({ providerID: "openai", modelID: "gpt-5" })).toBe(
      "openai::gpt-5",
    );
    expect(
      autoModelValue({ providerID: "openai", modelID: "gpt-5", accountId: "acct-1" }),
    ).toBe("acct-1::openai::gpt-5");
    // An empty accountId must not emit a leading separator.
    expect(
      autoModelValue({ providerID: "openai", modelID: "gpt-5", accountId: "" }),
    ).toBe("openai::gpt-5");
  });
});
