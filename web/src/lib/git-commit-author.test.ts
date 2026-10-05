import { describe, expect, it } from "vitest";
import {
  DEFAULT_GIT_COMMIT_AUTHOR_SETTINGS,
  parseGitCommitAuthorSettings,
  resolveGitCommitAuthor,
  validateGitCommitAuthorSetting,
} from "./git-commit-author";

describe("git commit author settings", () => {
  it("defaults to the agent name and machine-specific email", () => {
    expect(parseGitCommitAuthorSettings(null)).toEqual({
      nameTemplate: "{agent}",
      emailTemplate: "{agent}@leafcodepi.{machine}",
    });
    expect(resolveGitCommitAuthor("default", DEFAULT_GIT_COMMIT_AUTHOR_SETTINGS, "x870")).toEqual({
      name: "default",
      email: "default@leafcodepi.x870",
    });
  });

  it("renders custom templates for each agent", () => {
    const raw = JSON.stringify({
      nameTemplate: "Code Agent ({agent})",
      emailTemplate: "{agent}@leafcodepi.{machine}",
    });
    const normalized = validateGitCommitAuthorSetting(raw);
    expect(normalized).not.toBeNull();
    expect(resolveGitCommitAuthor("reviewer", parseGitCommitAuthorSettings(normalized), "x870")).toEqual({
      name: "Code Agent (reviewer)",
      email: "reviewer@leafcodepi.x870",
    });
  });

  it("migrates the previous fixed local suffix to the machine placeholder", () => {
    const stored = JSON.stringify({
      nameTemplate: "{agent}",
      emailTemplate: "{agent}@leafcodepi.local",
    });
    expect(parseGitCommitAuthorSettings(stored).emailTemplate)
      .toBe("{agent}@leafcodepi.{machine}");
  });

  it.each([
    "not json",
    JSON.stringify({ nameTemplate: "", emailTemplate: "bot@example.test" }),
    JSON.stringify({ nameTemplate: "bad\nname", emailTemplate: "bot@example.test" }),
    JSON.stringify({ nameTemplate: "Bot", emailTemplate: "bad email@example.test" }),
    JSON.stringify({ nameTemplate: "Bot", emailTemplate: "bot@@example.test" }),
  ])("rejects invalid setting %s", (value) => {
    expect(validateGitCommitAuthorSetting(value)).toBeNull();
  });
});
