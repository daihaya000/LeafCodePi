import { describe, expect, it } from "vitest";
import {
  MAX_COMPOSER_PROMPT_PRESETS,
  normalizeComposerPromptPresets,
  parseComposerPromptPresets,
} from "./composer-prompt-presets-schema";

describe("composer prompt presets schema", () => {
  it("normalizes prompt bodies and migrates the old object shape", () => {
    expect(normalizeComposerPromptPresets([
      "  変更を確認  ",
      "変更を確認",
      { name: "legacy", prompt: "  旧形式の本文  " },
      { name: "unused", prompt: "本文のみ" },
      "   ",
    ])).toEqual(["変更を確認", "旧形式の本文", "本文のみ"]);
  });

  it("rejects malformed server values and caps the number of entries", () => {
    expect(parseComposerPromptPresets("not-json")).toBeNull();
    expect(parseComposerPromptPresets(JSON.stringify([""]))).toBeNull();
    expect(parseComposerPromptPresets(JSON.stringify([{ prompt: "" }]))).toBeNull();
    expect(parseComposerPromptPresets(JSON.stringify([{ name: "legacy", prompt: "本文" }]))).toEqual(["本文"]);
    expect(parseComposerPromptPresets(JSON.stringify(["本文", "本文"]))).toEqual(["本文"]);
    const tooMany = Array.from({ length: MAX_COMPOSER_PROMPT_PRESETS + 1 }, (_, index) => `preset-${index}`);
    expect(parseComposerPromptPresets(JSON.stringify(tooMany))).toBeNull();
  });
});
