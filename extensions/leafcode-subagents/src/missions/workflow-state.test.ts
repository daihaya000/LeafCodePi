import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMissionWorkflowState, missionStatePath } from "./workflow-state.ts";

let root = "";
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

it("reclaims an aged lock that has a live pid but no processKey", () => {
	root = mkdtempSync(join(tmpdir(), "mission-state-lock-"));
	const location = {
		projectRoot: root,
		missionDir: join(root, "missions"),
		globalIndexDir: join(root, "index"),
		writeGlobalIndex: false,
	};
	const missionId = "mission-1";
	const statePath = missionStatePath(location, missionId);
	const lockPath = `${statePath}.lock`;
	mkdirSync(lockPath, { recursive: true });
	// Alive PID without a start-key must still age out; otherwise PID reuse pins the lock forever.
	writeFileSync(
		join(lockPath, "owner.json"),
		JSON.stringify({ pid: process.pid, token: "stale-token", createdAt: Date.now() - 120_000 }),
		"utf8",
	);

	const state = createMissionWorkflowState(location, missionId);
	state.set("checkpoint", "reclaimed");
	expect(state.get("checkpoint")).toBe("reclaimed");
});
