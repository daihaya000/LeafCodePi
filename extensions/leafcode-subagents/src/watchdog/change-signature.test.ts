import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { computeWatchdogRepoChangeSignature } from "./change-signature.ts";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore", windowsHide: true });
}

describe("computeWatchdogRepoChangeSignature", () => {
	it("changes with file content, stays equal otherwise, and survives a cached re-run", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-signature-"));
		try {
			git(dir, "init", "-q");
			fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
			const first = computeWatchdogRepoChangeSignature(dir);
			assert.ok(first);
			assert.deepEqual(first.changedPaths, ["a.txt"]);
			// Unchanged file: the cached hash gives the same key.
			assert.equal(computeWatchdogRepoChangeSignature(dir)?.key, first.key);
			// Same size, new content: the signature must move even though the hash was cached.
			fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
			const later = new Date(Date.now() + 5_000);
			fs.utimesSync(path.join(dir, "a.txt"), later, later);
			assert.notEqual(computeWatchdogRepoChangeSignature(dir)?.key, first.key);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
