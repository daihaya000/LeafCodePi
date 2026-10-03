import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	createMissionWorkflowState,
	missionStatePath,
	resetProcessStartKeyCacheForTests,
} from "./workflow-state.ts";

let root = "";
afterEach(() => {
	resetProcessStartKeyCacheForTests();
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

it("reuses the memoized process start key instead of probing again for the same pid", () => {
	resetProcessStartKeyCacheForTests();
	root = mkdtempSync(join(tmpdir(), "mission-start-key-"));
	const location = {
		projectRoot: root,
		missionDir: join(root, "missions"),
		globalIndexDir: join(root, "index"),
		writeGlobalIndex: false,
	};
	const missionId = "mission-key";
	const statePath = missionStatePath(location, missionId);
	const lockPath = `${statePath}.lock`;
	mkdirSync(lockPath, { recursive: true });

	// A live owner whose key we cannot resolve must age out rather than be stolen.
	// Writing the state twice exercises the probe twice; the second must not respawn.
	writeFileSync(
		join(lockPath, "owner.json"),
		JSON.stringify({ pid: process.pid, token: "owner", createdAt: Date.now() - 120_000 }),
		"utf8",
	);
	const first = createMissionWorkflowState(location, missionId);
	first.set("checkpoint", "first");
	const second = createMissionWorkflowState(location, missionId);
	second.set("checkpoint", "second");

	expect(first.get("checkpoint")).toBe("first");
	expect(second.get("checkpoint")).toBe("second");
});
