import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RESTART_RESUME_PROMPT } from "../core/restart-resume.mjs";
import { ORPHANED_WORKING_TASK_ERROR } from "../core/task-runtime-lease.mjs";
import { createBackendStartup } from "./startup.mjs";

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

test("startup recovers orphan notifications dropped by the in-memory cap from persisted error rows", async (t) => {
  const ids = Array.from({ length: 105 }, (_, index) => `orphan-${String(index).padStart(3, "0")}`);
  const { dir, file } = fixture(t, ids.map((id, index) => task(id, "working", index === 0 ? { updatedAt: "2020-01-01T00:00:00.000Z" } : {})));
  const scheduled = [];
  const started = createBackendStartup({
    dataDir: () => dir,
    warn: () => {},
    schedule: (callback) => { scheduled.push(callback); },
    promptTask: async () => {},
    loadRuntime: async () => ({ ok: true, runtime: {} }),
  });
  started.store.storePath = () => file;

  const snapshots = ids.map((id) => ({ ...started.store.getTask(id) }));
  assert.equal(started.leases.reconcileOrphanedWorkingTasks().length, 105);
  assert.equal(started.leases.state.pendingOrphans.length, 100);
  await started.startup.start();

  assert.equal(scheduled.length, 104);
  assert.equal(started.resumePending().length, 104);
  assert.deepEqual(started.resumeSkipped(), [{ id: ids[0], reason: "interrupted too long ago" }]);
  assert.equal(started.store.getTask(ids[0]).orphanedSourceUpdatedAt, snapshots[0].updatedAt);
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

test("without a runtime no resume is attempted and no retry budget is written", async (t) => {
  const { dir, file } = fixture(t, [task("code-orphan", "working")]);
  const prompted = [];
  const started = createBackendStartup({ dataDir: () => dir, warn: () => {} });
  started.store.storePath = () => file;
  assert.equal(started.resumesOrphanedTasks(), false);
  await started.startup.start();
  assert.deepEqual(prompted, []);
  assert.deepEqual(started.resumePending(), ["code-orphan"]);
  assert.equal(existsSync(join(dir, "restart-resume.json")), false, "classification must not spend the retry budget");
});

test("a supplied runtime resumes the orphaned task through the core service", async (t) => {
  const { dir, file } = fixture(t, [task("code-orphan", "working")]);
  const prompted = [];
  const scheduled = [];
  const started = createBackendStartup({
    dataDir: () => dir,
    warn: () => {},
    // Run the delayed resume immediately instead of waiting out the real delay.
    schedule: (callback) => { scheduled.push(callback); },
    promptTask: async (id, prompt) => { prompted.push([id, prompt]); },
    // A prompt path without an attached runtime would spend the retry budget on refused prompts.
    loadRuntime: async () => ({ ok: true, runtime: { promptTask: async () => {} } }),
  });
  started.store.storePath = () => file;
  // A prompt path alone is not enough: the runtime attaches during startup, before the resume runs.
  assert.equal(started.resumesOrphanedTasks(), false);
  await started.startup.start();
  assert.equal(started.resumesOrphanedTasks(), true);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(prompted, [], "the resume waits for its scheduled delay");
  scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompted.map(([id]) => id), ["code-orphan"]);
  assert.equal(prompted[0][1], RESTART_RESUME_PROMPT);
  assert.equal(existsSync(join(dir, "restart-resume.json")), true, "the attempt budget is recorded before prompting");
});

test("a Goal Loop-owned task is never prompted even when a runtime is supplied", async (t) => {
  const { dir, file } = fixture(t, [task("loop-orphan", "working", { sessionId: "session-1" })]);
  const loopDir = join(dir, "goals-loop");
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(join(loopDir, "session-1.json"), `${JSON.stringify({ goal: "続けて", status: "running" })}
`, "utf8");
  const prompted = [];
  const scheduled = [];
  const started = createBackendStartup({
    dataDir: () => dir,
    warn: () => {},
    schedule: (callback) => { scheduled.push(callback); },
    promptTask: async (id) => { prompted.push(id); },
    loadRuntime: async () => ({ ok: true, runtime: { promptTask: async () => {} } }),
  });
  started.store.storePath = () => file;
  await started.startup.start();
  for (const callback of scheduled) callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompted, []);
  assert.equal(existsSync(join(dir, "restart-resume.json")), false);
});

test("a lifecycle-interrupted Goal Loop resumes through its control path with the restart instruction", async (t) => {
  const { dir, file } = fixture(t, [task("loop-orphan", "working", { sessionId: "session-1" })]);
  const loopDir = join(dir, "goals-loop");
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(join(loopDir, "session-1.json"), `${JSON.stringify({
    goal: "続けて",
    status: "running",
    turnCount: 2,
    retryInterruptedTurn: true,
    pendingTurnRecovery: true,
  })}\n`, "utf8");
  const prompted = [];
  const loopCommands = [];
  const scheduled = [];
  const started = createBackendStartup({
    dataDir: () => dir,
    warn: () => {},
    schedule: (callback) => { scheduled.push(callback); },
    promptTask: async (id, prompt) => { prompted.push([id, prompt]); },
    loadRuntime: async () => ({ ok: true, runtime: {
      promptTask: async () => {},
      goalLoopCommand: async (...args) => { loopCommands.push(args); return { status: "queued" }; },
    } }),
  });
  started.store.storePath = () => file;
  await started.startup.start();
  assert.deepEqual(started.resumePending(), ["loop-orphan"]);
  assert.deepEqual(started.resumeSkipped(), []);
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(loopCommands, [["loop-orphan", { action: "resume", restartPrompt: RESTART_RESUME_PROMPT }]]);
  assert.deepEqual(prompted, [], "Goal Loop must not receive a normal task prompt");
  assert.equal(existsSync(join(dir, "restart-resume.json")), true);
});

test("startup accepts a Goal Loop completed by late verification recovery", async (t) => {
  const { dir, file } = fixture(t, [task("late-verified", "working", { sessionId: "session-1" })]);
  mkdirSync(join(dir, "goals-loop"), { recursive: true });
  writeFileSync(join(dir, "goals-loop", "session-1.json"), JSON.stringify({
    goal: "Verify completion", status: "paused", pauseReason: "session_end",
    turnKind: "verification", pendingTurnRecovery: true,
  }), "utf8");
  const logs = [];
  const commands = [];
  const scheduled = [];
  const started = createBackendStartup({
    dataDir: () => dir,
    warn: (...args) => logs.push(args),
    schedule: (callback) => scheduled.push(callback),
    promptTask: async () => { assert.fail("must not send a normal task prompt"); },
    loadRuntime: async () => ({ ok: true, runtime: {
      goalLoopCommand: async (...args) => { commands.push(args); return { status: "completed" }; },
    } }),
  });
  started.store.storePath = () => file;
  await started.startup.start();
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, [["late-verified", { action: "resume", restartPrompt: RESTART_RESUME_PROMPT }]]);
  assert.ok(logs.some(([message]) => message === "resumed Goal Loop late-verified after restart"));
  assert.equal(logs.some(([, error]) => error !== undefined), false);
});

test("an operator-paused Goal Loop remains skipped during startup recovery", async (t) => {
  const { dir, file } = fixture(t, [task("loop-hold", "working", { sessionId: "session-1" })]);
  const loopDir = join(dir, "goals-loop");
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(join(loopDir, "session-1.json"), `${JSON.stringify({
    goal: "手動停止",
    status: "paused",
    pauseReason: "user",
  })}\n`, "utf8");
  const loopCommands = [];
  const scheduled = [];
  const started = createBackendStartup({
    dataDir: () => dir,
    warn: () => {},
    schedule: (callback) => { scheduled.push(callback); },
    promptTask: async () => {},
    loadRuntime: async () => ({ ok: true, runtime: {
      promptTask: async () => {},
      goalLoopCommand: async (...args) => { loopCommands.push(args); return { status: "queued" }; },
    } }),
  });
  started.store.storePath = () => file;
  await started.startup.start();
  assert.deepEqual(started.resumePending(), []);
  assert.deepEqual(started.resumeSkipped(), [{ id: "loop-hold", reason: "goal-loop-owned" }]);
  for (const callback of scheduled) callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(loopCommands, []);
  assert.equal(existsSync(join(dir, "restart-resume.json")), false);
});

test("a requested runtime is attached during startup and reported as available", async (t) => {
  const { dir, file } = fixture(t);
  const runtime = { promptTask: () => {} };
  const started = createBackendStartup({
    dataDir: () => dir,
    warn: () => {},
    loadRuntime: async () => ({ ok: true, runtime }),
  });
  started.store.storePath = () => file;
  assert.deepEqual(started.runtimeStatus(), { ok: false, reason: "not-requested" });
  await started.startup.start();
  assert.deepEqual(started.runtimeStatus(), { ok: true, runtime });
});

test("a runtime that cannot be attached is reported without stopping the startup", async (t) => {
  const { dir, file } = fixture(t, [task("orphan", "working")]);
  const started = createBackendStartup({
    dataDir: () => dir,
    warn: () => {},
    // The loader never throws; it reports a reason. Readiness stays the caller's decision.
    loadRuntime: async () => ({ ok: false, reason: "missing" }),
  });
  started.store.storePath = () => file;
  await started.startup.start();
  assert.deepEqual(started.runtimeStatus(), { ok: false, reason: "missing" });
  assert.equal(started.store.getTask("orphan").status, "error", "the startup prefix still reconciles");
});

test("without a loader the runtime is never attached", async (t) => {
  const { dir, file } = fixture(t);
  const started = createBackendStartup({ dataDir: () => dir, warn: () => {} });
  started.store.storePath = () => file;
  await started.startup.start();
  assert.deepEqual(started.runtimeStatus(), { ok: false, reason: "not-requested" });
});

test("the Bot store reads the same config files the Web app writes", async (t) => {
  const { dir, file } = fixture(t);
  const botId = "11111111-2222-3333-4444-555555555555";
  mkdirSync(join(dir, "bots", botId), { recursive: true });
  writeFileSync(join(dir, "bots", botId, "config.json"), `${JSON.stringify({
    id: botId,
    name: "Probe Bot",
    label: "probe",
    enabled: true,
    tools: ["read", "unknown-tool"],
    permissionMode: "ask",
    skills: { mode: "inherit", include: [], exclude: [] },
    notificationsEnabled: true,
    codeAutoApprove: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })}
`, "utf8");
  const started = createBackendStartup({ dataDir: () => dir, warn: () => {} });
  started.store.storePath = () => file;
  const bots = started.bots.list();
  assert.equal(bots.length, 1);
  assert.equal(bots[0].id, botId);
  assert.equal(bots[0].name, "Probe Bot");
  assert.deepEqual(bots[0].tools, ["read"], "only tools this build knows are exposed");
  assert.equal(typeof bots[0].soul, "string");
  assert.equal(started.bots.get(botId)?.name, "Probe Bot");
  assert.equal(started.bots.get("missing-bot"), null);
  // An id that is not a Bot id is refused rather than read from an arbitrary path.
  assert.equal(started.bots.get("../escape"), null);
});

test("a detached Backend reports no missing service and reconciles the store", async (t) => {
  const { dir, file } = fixture(t);
  const started = createBackendStartup({ dataDir: () => dir, warn: () => {} });
  started.store.storePath = () => file;
  assert.deepEqual(started.unavailable(), []);
  await started.startup.start();
  assert.deepEqual(started.unavailable(), []);
  // A second start shares the first attempt, so nothing is reported twice.
  await started.startup.start();
  assert.deepEqual(started.unavailable(), []);
  assert.deepEqual(started.orphaned(), []);
});

test("every owner-only service starts, in order, once a runtime is attached", async (t) => {
  const { dir, file } = fixture(t);
  const calls = [];
  const attached = createBackendStartup({
    dataDir: () => dir,
    warn: () => {},
    loadRuntime: async () => ({
      ok: true,
      runtime: {
        startBotCodeRelay: () => calls.push("relay"),
        ensureRoutineScheduler: () => calls.push("routines"),
        ensureCodexResetScheduler: () => calls.push("codex-resets"),
        reconcileRoomRuntime: () => calls.push("rooms"),
      },
      generation: "gen-1",
    }),
  });
  attached.store.storePath = () => file;
  await attached.startup.start();
  assert.deepEqual(calls, ["relay", "routines", "codex-resets", "rooms"]);
  // Nothing is missing or failed: this is a complete startup as far as the steps are concerned.
  assert.deepEqual(attached.unavailable(), []);

  const failed = createBackendStartup({
    dataDir: () => dir,
    warn: () => {},
    loadRuntime: async () => ({ ok: false, reason: "missing" }),
  });
  failed.store.storePath = () => file;
  await failed.startup.start();
  assert.deepEqual(calls, ["relay", "routines", "codex-resets", "rooms"], "a bundle that never attached starts no owner work");
  assert.deepEqual(failed.unavailable(), [], "a detached Backend reports no failed step");
  assert.equal(failed.runtimeStatus().ok, false);
});

test("owner-only services that cannot start are reported instead of stopping the sequence", async (t) => {
  const { dir, file } = fixture(t);
  const started = createBackendStartup({
    dataDir: () => dir,
    warn: () => {},
    loadRuntime: async () => ({
      ok: true,
      runtime: {
        startBotCodeRelay: () => { throw new Error("outbox unavailable"); },
        ensureRoutineScheduler: () => { throw new Error("lock unavailable"); },
        ensureCodexResetScheduler: () => { throw new Error("reset scheduler unavailable"); },
        reconcileRoomRuntime: () => { throw new Error("rooms unavailable"); },
      },
      generation: "gen-1",
    }),
  });
  started.store.storePath = () => file;
  await started.startup.start();
  assert.deepEqual(started.unavailable(), ["startBotCodeRelay", "ensureRoutineScheduler", "ensureCodexResetScheduler", "reconcileRoomRuntime"]);
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

test("owner initialization completes before publication, reconciliation and runtime services; concurrent starts share it", async (t) => {
  const { dir, file } = fixture(t, [task("orphan", "working")]); const calls = [];
  let release, entered; const held = new Promise((resolve) => { release = resolve; }); const initializing = new Promise((resolve) => { entered = resolve; });
  const runtime = { startBotCodeRelay() { calls.push("relay"); }, ensureRoutineScheduler() { calls.push("routines"); }, reconcileRoomRuntime() { calls.push("rooms"); } };
  const started = createBackendStartup({ dataDir: () => dir, warn() {},
    loadRuntime: async () => ({ ok: true, runtime, generation: "fixture-generation" }),
    initializeRuntime: async (loaded) => { assert.equal(loaded, runtime); calls.push("initialize"); entered(); await held; calls.push("initialized"); },
  }); started.store.storePath = () => file;
  const pending = started.startup.start(); assert.equal(started.startup.start(), pending); await initializing;
  assert.equal(started.runtime(), null); assert.equal(started.resumesOrphanedTasks(), false);
  assert.equal(started.store.getTask("orphan").status, "working"); assert.deepEqual(calls, ["initialize"]);
  release(); await pending; assert.equal(started.runtime(), runtime);
  assert.equal(started.runtimeStatus().generation, "fixture-generation"); assert.equal(started.store.getTask("orphan").status, "error");
  assert.deepEqual(calls, ["initialize", "initialized", "relay", "routines", "rooms"]);
});

test("failed or unacknowledged initialization detaches the runtime, reports the step and still reconciles", async (t) => {
  for (const initializeRuntime of [async () => { throw Error("private credentials/path"); }, () => ({ success: true })]) {
    const { dir, file } = fixture(t, [task("orphan", "working")]); const calls = [];
    const started = createBackendStartup({ dataDir: () => dir, warn() {}, initializeRuntime,
      loadRuntime: async () => ({ ok: true, runtime: { startBotCodeRelay() { calls.push("relay"); } } }),
      promptTask: async () => { calls.push("resume"); },
    }); started.store.storePath = () => file;
    await started.startup.start();
    assert.deepEqual(started.runtimeStatus(), { ok: false, reason: "initialization-failed" }); assert.equal(started.runtime(), null);
    // Health must name the failed step, and the store-only reconciliation prefix still runs.
    assert.deepEqual(started.unavailable(), ["initializeRuntime"]);
    assert.equal(started.store.getTask("orphan").status, "error");
    assert.deepEqual(calls, []); assert.deepEqual(started.resumePending(), ["orphan"]);
    assert.equal(existsSync(join(dir, "restart-resume.json")), false);
  }
});

test("initialization is never invoked for a detached/missing runtime and invalid initializer options refuse", async (t) => {
  let calls = 0; const initializeRuntime = () => { calls++; };
  assert.throws(() => createBackendStartup({ initializeRuntime: true }), /initializeRuntime must be a function/);
  for (const extra of [{}, { loadRuntime: async () => ({ ok: false, reason: "missing" }) }]) {
    const { dir, file } = fixture(t);
    const started = createBackendStartup({ dataDir: () => dir, warn() {}, initializeRuntime, ...extra }); started.store.storePath = () => file;
    await started.startup.start(); assert.equal(started.runtime(), null);
  }
  assert.equal(calls, 0);
});

test("cancelWarmups is safe on a startup with no warmup services", async (t) => {
  const { dir, file } = fixture(t);
  const started = createBackendStartup({ dataDir: () => dir, warn: () => {} });
  started.store.storePath = () => file;
  await started.startup.start();
  started.startup.cancelWarmups();
  assert.deepEqual(started.unavailable(), []);
});
