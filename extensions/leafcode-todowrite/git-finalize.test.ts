import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildGitFinalizeArgs, gitFinalizeCommand, validateGitFinalizeAddPaths } from "./git-finalize.ts";

describe("restricted Git finalization", () => {
  it.each([
    { operation: "status" }, { operation: "diff", staged: true, paths: ["src/a.ts"] },
    { operation: "log", limit: 3 }, { operation: "show", revision: "HEAD~1" },
    { operation: "add", paths: ["src/a.ts", "削除.ts"] }, { operation: "commit", message: "変更を保存" },
    { operation: "push", remote: "origin", branch: "master" }, { operation: "fetch" }, { operation: "rev_parse" },
  ])("builds fixed argv for %j", (input) => {
    expect(buildGitFinalizeArgs(input).slice(0, 2)).toEqual(["--no-pager", "--literal-pathspecs"]);
  });
  it.each([
    null, {}, { operation: "__proto__" }, { operation: "merge" }, { operation: "pull" },
    { operation: "status", command: "Remove-Item x" }, { operation: "status", cwd: "/tmp" },
    { operation: "push", args: ["--force"] }, { operation: "push", remote: "https://example.com/repo" },
    { operation: "push", branch: "--force" }, { operation: "fetch", remote: "-f" },
    { operation: "show", revision: "--output=file" }, { operation: "show", revision: "HEAD; rm x" },
    { operation: "log", limit: 101 }, { operation: "log", limit: "2" },
    { operation: "diff", staged: "true" }, { operation: "add", paths: [] },
    { operation: "add", paths: ["."] }, { operation: "add", paths: ["./."] },
    { operation: "add", paths: ["src/.."] }, { operation: "add", paths: ["C:\\"] },
    { operation: "commit", message: "first\nsecond" },
    { operation: "commit", message: "" }, { operation: "add", paths: ["file\0.ts"] },
  ])("rejects malformed or overpowered inputs: %j", (input) => {
    expect(() => buildGitFinalizeArgs(input)).toThrow();
  });
  it("stages files only, verifies exact deleted paths, and rejects tracked directory prefixes", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-git-paths-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "file.txt"), "test");
      const tracked = vi.fn(async () => ["deleted.txt", "old/file.txt"]);
      await expect(validateGitFinalizeAddPaths({ operation: "add", paths: ["src/file.txt"] }, root, tracked)).resolves.toBeUndefined();
      expect(tracked).not.toHaveBeenCalled();
      await expect(validateGitFinalizeAddPaths({ operation: "add", paths: ["src"] }, root, tracked)).rejects.toThrow("一括stage");
      await expect(validateGitFinalizeAddPaths({ operation: "add", paths: ["deleted.txt"] }, root, tracked)).resolves.toBeUndefined();
      await expect(validateGitFinalizeAddPaths({ operation: "add", paths: ["old"] }, root, tracked)).rejects.toThrow("追跡済みファイル");
      await expect(validateGitFinalizeAddPaths({ operation: "add", paths: ["missing.txt"] }, root, tracked)).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("quotes shell characters as literal Git arguments in both shell dialects", () => {
    const args = buildGitFinalizeArgs({ operation: "commit", message: "a'; Remove-Item x; $HOME && b" });
    expect(gitFinalizeCommand(args, "powershell")).toContain("'a''; Remove-Item x; $HOME && b'");
    expect(gitFinalizeCommand(args, "bash")).toContain("'a'\"'\"'; Remove-Item x; $HOME && b'");
  });
});
