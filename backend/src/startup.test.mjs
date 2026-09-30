import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ORPHANED_WORKING_TASK_ERROR } from "../core/task-runtime-lease.mjs";
import { BACKEND_UNAVAILABLE_STARTUP_STEPS, createBackendStartup } from "./startup.mjs";

/** A temp data dir plus a store file, both outside the real user data. */
function fixture(t, tasks = []) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-backend-startup-"));
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  const file = join(root, "store.json");
  writeFileSync(file, `${JSON.stringify({ version: 1, projects: [], tasks })}\n`, "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dir, file };
}

const task = (id, status, extra = {}) => ({
  id,
  projectId: null,
  projectName: "プロジェクトなし",
  title: id,
  directory: "/tmp",
  isolation: "current_folder",
  status,
  sessionId: null,
  sessionFile: null,
  providerID: "test",
  modelID: "test",
  createdAt: "2026-01-01T00:00:00.000Z",
  // Recent by default: restart-resume refuses anything interrupted over 12 hours ago.
  updatedAt: new Date().toISOString(),
  ...extra,
});

test("startup reconciles working tasks without a live lease and leaves others alone", async (t) => {
  const { dir, file } = fixture(t, [task("orphan", "working"), task("idle", "idle"), task("done", "complete")]);
  const started = createBackendStartup({ dataDir: () => dir, warn: () => {} });
  // Point the store at the fixture file without touching the real data dir.
  started.store.storePath = () => file;
  await started.startup.start();
  assert.deepEqual(started.orphaned(), ["orphan"]);
  assert.equal(started.store.getTask("orphan").status, "error");
  assert.equal(started.store.getTask("orphan").error, ORPHANED_WORKING_TASK_ERROR);
  assert.equal(started.store.getTask("idle").status, "idle");
  assert.equal(started.store.getTask("done").status, "complete");
});

test("a working task with a live lease is not reconciled", async (t) => {
  const { dir, file } = fixture(t, [task("live", "working")]);
  const started = createBackendStartup({ dataDir: () => dir, warn: () => {} });
  started.store.storePath = () => file;
  // A lease owned by a live process with a fresh heartbeat, as the Web would write it.
  const leaseDir = join(dir, "task-leases");
  mkdirSync(leaseDir, { recursive: true });
  writeFileSync(join(leaseDir, "live.json"), `${JSON.stringify({
    token: "web-process-token", pid: process.pid, acquiredAt: Date.now(), heartbeatAt: Date.now(),
  })}\n`, "utf8");
  await started.startup.start();
  assert.deepEqual(started.orphaned(), []);
  assert.equal(started.store.getTask("live").status, "working");
});

test("resume classification separates resumable tasks from the core ladder's refusals", async (t) => {
  const { dir, file } = fixture(t, [
    task("code-orphan", "working"),
    task("bot-orphan", "working", { kind: "bot", botId: "bot-1" }),
    task("stale-orphan", "working", { updatedAt: "2020-01-01T00:00:00.000Z" }),
  ]);
  const started = createBackendStartup({ dataDir: () => dir, warn: () => {} });
  started.store.storePath = () => file;
  await started.startup.start();
  assert.deepEqual(started.resumePending(), ["code-orphan"]);
  assert.deepEqual(started.resumeSkipped(), [
    // The Bot check runs before the staleness check, so the Bot reason wins here.
    { id: "stale-orphan", reason: "interrupted too long ago" },
    { id: "bot-orphan", reason: "not a Code task" },
  ]);
  // Nothing was attempted, so no retry budget was spent.
  assert.equal(existsSync(join(dir, "restart-resume.json")), false);
});

test("a Goal Loop-owned session is refused by the same ladder, without a resume", async (t) => {
  const { dir, file } = fixture(t, [task("loop-orphan", "working", { sessionId: "session-1" })]);
  const started = createBackendStartup({ dataDir: () => dir, warn: () => {} });
  started.store.storePath = () => file;
  // The Goal Loop state file lives under <dataDir>/goals-loop/<sanitized session>.json.
  const loopDir = join(dir, "goals-loop");
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(join(loopDir, "session-1.json"), `${JSON.stringify({ goal: "続けて", status: "running" })}
`, "utf8");
  await started.startup.start();
  assert.deepEqual(started.resumePending(), []);
  assert.deepEqual(started.resumeSkipped(), [{ id: "loop-orphan", reason: "goal-loop-owned" }]);
  assert.equal(existsSync(join(dir, "restart-resume.json")), false);
});

test("the services the Backend cannot run yet are reported, not silently skipped", async (t) => {
  const { dir, file } = fixture(t);
  const started = createBackendStartup({ dataDir: () => dir, warn: () => {} });
  started.store.storePath = () => file;
  assert.deepEqual(started.unavailable(), []);
  await started.startup.start();
  assert.deepEqual(started.unavailable(), [...BACKEND_UNAVAILABLE_STARTUP_STEPS]);
  // A second start shares the first attempt, so nothing is reported twice.
  await started.startup.start();
  assert.deepEqual(started.unavailable(), [...BACKEND_UNAVAILABLE_STARTUP_STEPS]);
  assert.deepEqual(started.orphaned(), []);
});

test("a restart-resume listener that fails does not stop the sequence", async (t) => {
  const { dir, file } = fixture(t, [task("orphan", "working")]);
  const warnings = [];
  const started = createBackendStartup({ dataDir: () => dir, warn: (...args) => warnings.push(args) });
  started.store.storePath = () => file;
  started.leases.setOrphanedTaskListener = () => { throw new Error("listener registration failed"); };
  await started.startup.start();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "[restart-resume] unavailable");
  assert.equal(started.store.getTask("orphan").status, "error", "reconciliation still runs after a failed registration");
});

test("cancelWarmups is safe on a startup with no warmup services", async (t) => {
  const { dir, file } = fixture(t);
  const started = createBackendStartup({ dataDir: () => dir, warn: () => {} });
  started.store.storePath = () => file;
  await started.startup.start();
  started.startup.cancelWarmups();
  assert.deepEqual(started.unavailable(), [...BACKEND_UNAVAILABLE_STARTUP_STEPS]);
});
