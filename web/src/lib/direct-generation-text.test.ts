import { describe, expect, it } from "vitest";
import {
  buildTranscript,
  formatConversationForPrompt,
  formatRepoSnapshotForPrompt,
  formatTranscriptForTitle,
  normalizeSuggestion,
  parseDirectGenerationModelResponse,
  sanitizePreviousSuggestions,
  sanitizeTitle,
} from "./direct-generation-text";

const conversation = [
  { role: "user" as const, text: "ログイン画面を直して" },
  { role: "assistant" as const, text: "原因を調査します" },
];

describe("direct-generation-text", () => {
  it("formats bounded conversation prompts as data", () => {
    expect(formatTranscriptForTitle(conversation)).toContain("<transcript>");
    expect(formatConversationForPrompt(conversation)).toContain("<conversation>");
    expect(formatConversationForPrompt([{ role: "user", text: "あ".repeat(20) }], []).length).toBeGreaterThan(0);
    expect(buildTranscript([{ role: "user", text: "あ".repeat(20) }], 5)).toBe("あああああ");
  });

  it("normalizes titles and suggestions without model decoration", () => {
    expect(sanitizeTitle('「タイトル案」\n補足')).toBe("タイトル案");
    expect(normalizeSuggestion("1. `npm test を実行する`\n補足")).toBe("npm test を実行する");
    expect(sanitizePreviousSuggestions(["同じ", "同じ", "", 1])).toEqual(["同じ"]);
  });

  it("parses the model metadata from a generation response", () => {
    expect(
      parseDirectGenerationModelResponse({
        model: { providerID: "opencode-go", modelID: "mimo-v2.5" },
      }),
    ).toEqual({ providerID: "opencode-go", modelID: "mimo-v2.5" });
    expect(parseDirectGenerationModelResponse({ model: null })).toBeUndefined();
  });

  it("builds a repository prompt only when there is actionable state", () => {
    expect(
      formatRepoSnapshotForPrompt({
        projectName: "LeafCodePi",
        currentBranch: "main",
        status: " M web/src/app.ts",
        diff: "+new line",
        commits: [],
        recentTasks: [],
      }),
    ).toContain("web/src/app.ts");
    expect(
      formatRepoSnapshotForPrompt({
        projectName: "LeafCodePi",
        currentBranch: null,
        status: "",
        diff: "",
        commits: [],
        recentTasks: [],
      }),
    ).toBe("");
  });
});
