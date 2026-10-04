import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	createMissionWorkflowState,
	missionStatePath,
	resetProcessStartKeyCacheForTests,
	startKeyProbeCountForTests,
	stateLockIsStale,
} from "./workflow-state.ts";

let root = "";
afterEach(() => {
	resetProcessStartKeyCacheForTests();
	if (root) rmSync(root, { recursive: true, force: true });
});

it("does not reclaim an aged lock while its live owner has no processKey", () => {
	root = mkdtempSync(join(tmpdir(), "mission-state-lock-"));
	const lockPath = join(root, "state.json.lock");
	mkdirSync(lockPath, { recursive: true });
	const createdAt = Date.now() - 120_000;
	const ownerPath = join(lockPath, "owner.json");
	writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token: "live-token", createdAt }), "utf8");

	expect(stateLockIsStale(lockPath, Date.now())).toBe(false);
	expect(stateLockIsStale(lockPath, createdAt + 11 * 60_000)).toBe(false);

	writeFileSync(ownerPath, JSON.stringify({ pid: 2_147_483_646, token: "dead-token", createdAt }), "utf8");
	expect(stateLockIsStale(lockPath, Date.now())).toBe(true);
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
		JSON.stringify({ pid: 2_147_483_646, token: "owner", createdAt: Date.now() - 120_000 }),
		"utf8",
	);
	const first = createMissionWorkflowState(location, missionId);
	first.set("checkpoint", "first");
	const second = createMissionWorkflowState(location, missionId);
	second.set("checkpoint", "second");

	// Both instances share one file, so each read sees the latest write (no stale per-instance copy).
	expect(first.get("checkpoint")).toBe("second");
	expect(second.get("checkpoint")).toBe("second");
});

it("does not probe the owner while the lock is young", () => {
	resetProcessStartKeyCacheForTests();
	root = mkdtempSync(join(tmpdir(), "mission-young-lock-"));
	const location = {
		projectRoot: root,
		missionDir: join(root, "missions"),
		globalIndexDir: join(root, "index"),
		writeGlobalIndex: false,
	};
	const statePath = missionStatePath(location, "mission-young");
	const lockPath = `${statePath}.lock`;
	mkdirSync(lockPath, { recursive: true });
	// A fresh owner with a start key cannot be stale, so the PowerShell probe
	// (up to 1s of blocked event loop) must not run on any retry.
	writeFileSync(
		join(lockPath, "owner.json"),
		JSON.stringify({ pid: process.pid, token: "young", createdAt: Date.now(), processKey: "live-key" }),
		"utf8",
	);
	resetProcessStartKeyCacheForTests();
	assert.throws(
		() => createMissionWorkflowState(location, "mission-young").set("checkpoint", "waiting"),
		/Timed out acquiring mission state lock/,
	);

	expect(startKeyProbeCountForTests()).toBe(0);
	expect(existsSync(lockPath)).toBe(true);
}, 20_000);

it("keeps an aged lock whose live owner's start key cannot be verified", () => {
	root = mkdtempSync(join(tmpdir(), "mission-unverifiable-lock-"));
	const lockPath = join(root, "state.json.lock");
	mkdirSync(lockPath, { recursive: true });
	const writeOwner = (ageMs: number) => writeFileSync(
		join(lockPath, "owner.json"),
		JSON.stringify({ pid: process.ppid, token: "owner", createdAt: Date.now() - ageMs, processKey: "recorded-key" }),
		"utf8",
	);
	// Another live process (not this one, whose own key is cached) stands in for the owner.
	const failedProbe = () => undefined;
	// The probe failed (slow PowerShell): an aged but live owner is not stolen...
	writeOwner(120_000);
	expect(stateLockIsStale(lockPath, Date.now(), failedProbe)).toBe(false);
	// ...a probe that succeeds with a different key still proves pid reuse...
	expect(stateLockIsStale(lockPath, Date.now(), () => "other-key")).toBe(true);
	// A failed probe is inconclusive regardless of age; PID reuse was not proven.
	writeOwner(11 * 60_000);
	expect(stateLockIsStale(lockPath, Date.now(), failedProbe)).toBe(false);
});

it("get sees a value another worker set after this instance first read the file", () => {
	root = mkdtempSync(join(tmpdir(), "mission-state-fresh-"));
	const location = {
		projectRoot: root,
		missionDir: join(root, "missions"),
		globalIndexDir: join(root, "index"),
		writeGlobalIndex: false,
	};
	const reader = createMissionWorkflowState(location, "mission-fresh");
	const writer = createMissionWorkflowState(location, "mission-fresh");
	expect(reader.get("checkpoint")).toBeUndefined();
	writer.set("checkpoint", "from-other-worker");
	expect(reader.get("checkpoint")).toBe("from-other-worker");
	// A longer value changes the size even if the timestamp resolution is coarse.
	writer.set("checkpoint", "from-other-worker-again");
	expect(reader.get("checkpoint")).toBe("from-other-worker-again");
	reader.set("other", 1);
	expect(reader.get("checkpoint")).toBe("from-other-worker-again");
	expect(writer.get("other")).toBe(1);
});

it("get sees same-size external updates when the file timestamp is unchanged", () => {
	root = mkdtempSync(join(tmpdir(), "mission-state-same-signature-"));
	const location = {
		projectRoot: root,
		missionDir: join(root, "missions"),
		globalIndexDir: join(root, "index"),
		writeGlobalIndex: false,
	};
	const reader = createMissionWorkflowState(location, "mission-same-signature");
	const writer = createMissionWorkflowState(location, "mission-same-signature");
	reader.set("checkpoint", "before");
	const fixedTime = new Date("2024-01-01T00:00:00.000Z");
	utimesSync(reader.path, fixedTime, fixedTime);
	const before = statSync(reader.path);
	expect(reader.get("checkpoint")).toBe("before");

	writer.set("checkpoint", "after!");
	utimesSync(reader.path, fixedTime, fixedTime);
	const after = statSync(reader.path);
	expect(after.size).toBe(before.size);
	expect(after.mtimeMs).toBe(before.mtimeMs);
	expect(reader.get("checkpoint")).toBe("after!");
});
