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
	it("resolves a repository identity and treats the same cwd as the same repo", () => {
		const cwd = process.cwd();
		const identity = resolveGitRepositoryIdentity(cwd);
		expect(identity?.root).toBeTruthy();
		const result = resolveWorkflowChatProgress({ requested: undefined, parentCwd: cwd, workflowCwd: cwd, background: false });
		expect(result.projection).toMatchObject({ mode: "live-card", repoRelation: "same" });
	});

	it("returns undefined outside a git repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "chat-progress-nogit-"));
		try {
			expect(resolveGitRepositoryIdentity(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("workflow chat progress identity cache", () => {
  it("resolves one repository identity per cwd inside the TTL", () => {
    resetGitRepositoryIdentityCacheForTests();
    const cwd = process.cwd();
    // Every call resolves the same identity, and the second one is served from
    // the cache instead of spawning `git rev-parse` again.
    const first = resolveGitRepositoryIdentity(cwd);
    const second = resolveGitRepositoryIdentity(cwd);
    expect(first).toBeTruthy();
    expect(second).toBe(first);

    // The workflow projection reaches the same answer for both cwds.
    resetGitRepositoryIdentityCacheForTests();
    const projection = resolveWorkflowChatProgress({
      requested: "auto",
      parentCwd: cwd,
      workflowCwd: cwd,
      background: false,
    });
    expect(projection.projection).toMatchObject({ mode: "live-card", repoRelation: "same" });
    resetGitRepositoryIdentityCacheForTests();
  });
});
