import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPowerShellTool } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { buildGitFinalizeArgs, gitFinalizeCommand, validateGitFinalizeAddPaths } from "@extensions/leafcode-todowrite/git-finalize";

it.runIf(process.platform !== "win32")("applies configured author and committer identities through native Bash and Git", () => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-git-finalize-bash-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5_000 });
  try {
    git("init", "--quiet");
    git("config", "user.name", "Repository fallback");
    git("config", "user.email", "fallback@example.invalid");
    git("config", "commit.gpgSign", "false");
    writeFileSync(join(root, "file.txt"), "test");
    git("add", "--", "file.txt");
    const author = { name: "LeafCodePi (reviewer)", email: "reviewer@example.invalid" };
    const command = gitFinalizeCommand(buildGitFinalizeArgs({ operation: "commit", message: "test", agent: "reviewer" }), "bash", author);
    execFileSync("bash", ["-c", command], { cwd: root, encoding: "utf8", timeout: 5_000 });
    expect(git("log", "-1", "--format=%an <%ae>|%cn <%ce>").trim()).toBe(
      "LeafCodePi (reviewer) <reviewer@example.invalid>|LeafCodePi (reviewer) <reviewer@example.invalid>",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10_000);

it.runIf(process.platform === "win32")("preserves quote-heavy messages through real native PowerShell and Git", async () => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-git-finalize-native-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5_000 });
  try {
    git("init", "--quiet");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "file.txt"), "test");
    git("add", "--", "file.txt");
    const message = 'fix "quote"; literal $HOME && apostrophe\u0027 日本語';
    const author = { name: "LeafCodePi (reviewer)", email: "reviewer@example.invalid" };
    const command = gitFinalizeCommand(buildGitFinalizeArgs({ operation: "commit", message, agent: "reviewer" }), "powershell", author);
    const result = await createPowerShellTool(root).execute("test", { command, timeout: 10 });
    expect(result.isError).not.toBe(true);
    expect(git("log", "-1", "--format=%B").trim()).toBe(message);
    expect(git("log", "-1", "--format=%an <%ae>|%cn <%ce>").trim()).toBe(
      "LeafCodePi (reviewer) <reviewer@example.invalid>|LeafCodePi (reviewer) <reviewer@example.invalid>",
    );
    rmSync(join(root, "file.txt"));
    await validateGitFinalizeAddPaths({ operation: "add", paths: ["file.txt"] }, root, async (paths) => {
      const probe = await createPowerShellTool(root).execute("probe", {
        command: gitFinalizeCommand(["--literal-pathspecs", "ls-files", "-z", "--", ...paths], "powershell"), timeout: 10,
      });
      const structured = probe.structuredContent as { output: string; truncated: boolean };
      expect(structured.truncated).toBe(false);
      return structured.output.split("\0").filter(Boolean);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
