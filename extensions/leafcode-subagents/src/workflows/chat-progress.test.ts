import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resetGitRepositoryIdentityCacheForTests,
  resolveGitRepositoryIdentity,
  resolveWorkflowChatProgress,
} from "./chat-progress.ts";

describe("workflow chat progress git identity", () => {
	it("resolves a repository identity and treats the same cwd as the same repo", async () => {
		const cwd = process.cwd();
		const identity = await resolveGitRepositoryIdentity(cwd);
		expect(identity?.root).toBeTruthy();
		const result = await resolveWorkflowChatProgress({ requested: undefined, parentCwd: cwd, workflowCwd: cwd, background: false });
		expect(result.projection).toMatchObject({ mode: "live-card", repoRelation: "same" });
	});

	it("returns undefined outside a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "chat-progress-nogit-"));
		try {
			expect(await resolveGitRepositoryIdentity(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("workflow chat progress identity cache", () => {
  it("shares concurrent repository probes and caches the identity", async () => {
    resetGitRepositoryIdentityCacheForTests();
    const cwd = process.cwd();
    const [first, second] = await Promise.all([
      resolveGitRepositoryIdentity(cwd),
      resolveGitRepositoryIdentity(cwd),
    ]);
    expect(first).toBeTruthy();
    expect(second).toBe(first);

    const projection = await resolveWorkflowChatProgress({
      requested: "auto",
      parentCwd: cwd,
      workflowCwd: cwd,
      background: false,
    });
    expect(projection.projection).toMatchObject({ mode: "live-card", repoRelation: "same" });
    resetGitRepositoryIdentityCacheForTests();
  });
});
