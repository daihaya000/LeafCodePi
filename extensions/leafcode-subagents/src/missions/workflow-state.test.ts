import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

it("keeps an aged lock whose live owner's start key cannot be verified, until the hard cap", () => {
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
	// ...and an owner unverifiable for the whole hard cap is aged out.
	writeOwner(11 * 60_000);
	expect(stateLockIsStale(lockPath, Date.now(), failedProbe)).toBe(true);
});