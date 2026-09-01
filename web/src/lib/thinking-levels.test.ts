import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  THINKING_LEVEL_LABELS,
  clampThinkingLevelForModel,
  defaultThinkingLevel,
  isThinkingLevel,
  resolveThinkingLevel,
  thinkingLevelLabel,
  thinkingLevelMetaLabel,
  thinkingLevelsForModel,
} from "./thinking-levels";

function fakeModel(partial: Partial<Model<Api>> & Pick<Model<Api>, "id">): Model<Api> {
  return {
    name: partial.id,
    api: "openai-completions",
    provider: "test",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...partial,
  } as Model<Api>;
}

describe("thinking-levels", () => {
  it("exposes no options for non-reasoning models without an explicit off", () => {
    expect(thinkingLevelsForModel(fakeModel({ id: "plain", reasoning: false }))).toEqual([]);
  });

  it("drops off unless the provider defines it explicitly", () => {
    // map なしなら off は選択肢に現れない。
    expect(thinkingLevelsForModel(fakeModel({ id: "r0", reasoning: true }))).not.toContain("off");
    // 明示定義（値）があれば残る。
    const explicit = fakeModel({ id: "r1", reasoning: true, thinkingLevelMap: { off: "none" } });
    expect(thinkingLevelsForModel(explicit)).toContain("off");
  });

  it("picks medium as default and rounds to the nearest supported level", () => {
    expect(defaultThinkingLevel(["minimal", "low", "medium", "high"])).toBe("medium");
    expect(defaultThinkingLevel(["off", "minimal"])).toBe("minimal");
    expect(defaultThinkingLevel(["xhigh"])).toBe("xhigh");
    // 同距離は安い方（low/ xhigh から medium まで等距離なら low）。
    expect(defaultThinkingLevel(["low", "xhigh"])).toBe("low");
    expect(defaultThinkingLevel([])).toBe("off");
  });

  it("includes xhigh/max only when thinkingLevelMap declares them", () => {
    const base = thinkingLevelsForModel(fakeModel({ id: "rb", reasoning: true }));
    expect(base).toEqual(["minimal", "low", "medium", "high"]);

    const withXhigh = thinkingLevelsForModel(
      fakeModel({
        id: "r2",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: null },
      }),
    );
    expect(withXhigh).toContain("xhigh");
    expect(withXhigh).not.toContain("max");
  });

  it("clamps unsupported levels to the nearest supported one", () => {
    const model = fakeModel({
      id: "limited",
      reasoning: true,
      thinkingLevelMap: { high: null, xhigh: null, max: null },
    });
    expect(clampThinkingLevelForModel(model, "high")).toBe("medium");
    expect(isThinkingLevel("low")).toBe(true);
    expect(isThinkingLevel("turbo")).toBe(false);
  });

  it("does not promote a persisted level to an expensive level", () => {
    const qwen = fakeModel({
      id: "qwen35",
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: null,
        medium: null,
        high: null,
        max: null,
      },
    });
    const levels = thinkingLevelsForModel(qwen);
    expect(levels).toEqual(["off"]);
    expect(clampThinkingLevelForModel(qwen, "minimal")).toBe("off");
  });

  it("keeps a supported persisted level and defaults only when unsupported", () => {
    expect(resolveThinkingLevel(["low", "medium", "high"], "low")).toBe("low");
    expect(resolveThinkingLevel(["low", "medium", "high"], "xhigh")).toBe("medium");
    expect(resolveThinkingLevel([], "high")).toBe("off");
  });

  it("labels levels with model-baseline English names", () => {
    expect(THINKING_LEVEL_LABELS.off).toBe("off");
    expect(thinkingLevelLabel("xhigh")).toBe("xhigh");
  });

  it("shows the applied effort in metadata without depending on model options", () => {
    expect(thinkingLevelMetaLabel("max")).toBe("max");
    expect(thinkingLevelMetaLabel("off")).toBeUndefined();
    expect(thinkingLevelMetaLabel(undefined)).toBeUndefined();
  });
});
