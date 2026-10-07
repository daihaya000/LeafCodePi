import { describe, expect, it } from "vitest";
import { buildGitFinalizeArgs, gitFinalizeCommand } from "./git-finalize.ts";

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
    { operation: "add", paths: ["."] }, { operation: "commit", message: "first\nsecond" },
    { operation: "commit", message: "" }, { operation: "add", paths: ["file\0.ts"] },
  ])("rejects malformed or overpowered inputs: %j", (input) => {
    expect(() => buildGitFinalizeArgs(input)).toThrow();
  });
  it("quotes shell characters as literal Git arguments in both shell dialects", () => {
    const args = buildGitFinalizeArgs({ operation: "commit", message: "a'; Remove-Item x; $HOME && b" });
    expect(gitFinalizeCommand(args, "powershell")).toContain("'a''; Remove-Item x; $HOME && b'");
    expect(gitFinalizeCommand(args, "bash")).toContain("'a'\"'\"'; Remove-Item x; $HOME && b'");
  });
});
