import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  THINKING_LEVEL_LABELS,
  clampThinkingLevelForModel,
  isThinkingLevel,
  thinkingLevelLabel,
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
  it("returns only off for non-reasoning models", () => {
    expect(thinkingLevelsForModel(fakeModel({ id: "plain", reasoning: false }))).toEqual(["off"]);
  });

  it("includes xhigh/max only when thinkingLevelMap declares them", () => {
    const base = thinkingLevelsForModel(fakeModel({ id: "r1", reasoning: true }));
    expect(base).toEqual(["off", "minimal", "low", "medium", "high"]);

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

  it("labels off as デフォルト when shown among effort options", () => {
    expect(THINKING_LEVEL_LABELS.off).toBe("デフォルト");
    expect(thinkingLevelLabel("off")).toBe("デフォルト");
  });
});
