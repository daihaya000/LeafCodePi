import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMachineName } from "../../backend/runtime-src/lib/machine-name.ts";
import { resolveConfiguredGitCommitAuthor } from "./git-commit-author.ts";

const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
});

describe("configured agent Git author", () => {
  it("uses the configured templates from web-settings.json", () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-commit-author-"));
    try {
      process.env.LEAFCODE_PI_DATA_DIR = root;
      writeFileSync(join(root, "web-settings.json"), JSON.stringify({
        version: 1,
        "git-commit-author": JSON.stringify({
          nameTemplate: "LeafCodePi ({agent})",
          emailTemplate: "{agent}@commit.example",
        }),
      }), "utf8");
      expect(resolveConfiguredGitCommitAuthor("reviewer")).toEqual({
        name: "LeafCodePi (reviewer)",
        email: "reviewer@commit.example",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the default agent and machine templates when the setting is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-commit-author-default-"));
    try {
      process.env.LEAFCODE_PI_DATA_DIR = root;
      expect(resolveConfiguredGitCommitAuthor()).toEqual({
        name: "default",
        email: `default@leafcodepi.${getMachineName()}`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
