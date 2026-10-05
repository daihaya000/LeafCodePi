import { describe, expect, it } from "vitest";
import {
  DEFAULT_GIT_COMMIT_AUTHOR_SETTINGS,
  parseGitCommitAuthorSettings,
  resolveGitCommitAuthor,
  validateGitCommitAuthorSetting,
} from "./git-commit-author";

describe("git commit author settings", () => {
  it("defaults to the agent name and leafcodepi.local email", () => {
    expect(parseGitCommitAuthorSettings(null)).toEqual({
      nameTemplate: "{agent}",
      emailTemplate: "{agent}@leafcodepi.local",
    });
    expect(resolveGitCommitAuthor("default", DEFAULT_GIT_COMMIT_AUTHOR_SETTINGS)).toEqual({
      name: "default",
      email: "default@leafcodepi.local",
    });
  });

  it("renders custom templates for each agent", () => {
    const raw = JSON.stringify({
      nameTemplate: "Code Agent ({agent})",
      emailTemplate: "{agent}+bot@example.test",
    });
    const normalized = validateGitCommitAuthorSetting(raw);
    expect(normalized).not.toBeNull();
    expect(resolveGitCommitAuthor("reviewer", parseGitCommitAuthorSettings(normalized))).toEqual({
      name: "Code Agent (reviewer)",
      email: "reviewer+bot@example.test",
    });
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
