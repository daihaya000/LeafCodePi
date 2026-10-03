import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGitRepositoryIdentity, resolveWorkflowChatProgress } from "./chat-progress.ts";

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
