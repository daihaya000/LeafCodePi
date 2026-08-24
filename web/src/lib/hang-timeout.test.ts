import { describe, expect, it } from "vitest";
import {
  autoResumePrompt,
  CONTINUE_PROMPT,
  DEFAULT_AUTO_RESUME_MODE,
  isAutoResumeMode,
} from "./hang-timeout";

describe("auto resume mode", () => {
  it("accepts only the supported modes", () => {
    expect(isAutoResumeMode("same")).toBe(true);
    expect(isAutoResumeMode("continue")).toBe(true);
    expect(isAutoResumeMode("other")).toBe(false);
    expect(DEFAULT_AUTO_RESUME_MODE).toBe("same");
  });

  it("uses the configured prompt", () => {
    expect(autoResumePrompt("same", "元のプロンプト")).toBe("元のプロンプト");
    expect(autoResumePrompt("continue", "元のプロンプト")).toBe(CONTINUE_PROMPT);
  });
});
