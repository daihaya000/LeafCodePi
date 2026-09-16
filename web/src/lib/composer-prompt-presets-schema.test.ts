import { describe, expect, it } from "vitest";
import {
  expandComposerPromptPresets,
  MAX_COMPOSER_PROMPT_PRESETS,
  normalizeComposerPromptPresets,
  parseComposerPromptPresets,
} from "./composer-prompt-presets-schema";

describe("composer prompt presets schema", () => {
  it("normalizes valid presets and drops invalid or duplicate entries", () => {
    expect(normalizeComposerPromptPresets([
      { name: " review ", prompt: "  変更を確認  " },
      { name: "REVIEW", prompt: "別の本文" },
      { name: "bad/name", prompt: "本文" },
      { name: "空", prompt: "   " },
    ])).toEqual([{ name: "review", prompt: "変更を確認" }]);
  });

  it("rejects malformed server values and caps the number of entries", () => {
    expect(parseComposerPromptPresets("not-json")).toBeNull();
    expect(parseComposerPromptPresets(JSON.stringify([{ name: "bad/name", prompt: "本文" }]))).toBeNull();
    const tooMany = Array.from({ length: MAX_COMPOSER_PROMPT_PRESETS + 1 }, (_, index) => ({
      name: `preset-${index}`,
      prompt: "本文",
    }));
    expect(parseComposerPromptPresets(JSON.stringify(tooMany))).toBeNull();
  });

  it("expands known tokens while leaving paths and unknown names untouched", () => {
    const presets = [{ name: "review", prompt: "変更をレビューしてください" }];
    expect(expandComposerPromptPresets("/prompt:review と /prompt:unknown /tmp/file", presets))
      .toBe("変更をレビューしてください と /prompt:unknown /tmp/file");
  });
});
