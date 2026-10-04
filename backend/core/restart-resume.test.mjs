import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  RestartResumeService, restartResumeRefusal, isGoalLoopRestartResumable,
  RESTART_RESUME_DELAY_MS, RESTART_RESUME_STAGGER_MS,
  RESTART_RESUME_WINDOW_MS, RESTART_RESUME_MAX_STALE_MS, RESTART_RESUME_PROMPT,
} from "./restart-resume.mjs";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const orphanError = "orphaned by worker restart";
const task = (overrides = {}) => ({
  id: "t1", kind: "code", status: "error", error: orphanError,
  updatedAt: new Date(NOW - 1_000).toISOString(), ...overrides,
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-backend-restart-resume-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new RestartResumeService({ dataDir: () => root, orphanedTaskError: orphanError });
  const prompts = [];
  const scheduled = [];
  const logs = [];
  const deps = {
    getTask: () => task(),
    promptTask: async (...args) => { prompts.push(args); },
    isGoalLoopOwned: () => false,
    isRoomDelegated: () => false,
    now: () => NOW,
    schedule: (callback, delayMs) => { scheduled.push({ callback, delayMs }); },
    log: (...args) => { logs.push(args); },
  };
  return { root, service, prompts, scheduled, logs, deps };
}

const readBudget = (root) => JSON.parse(readFileSync(join(root, "restart-resume.json"), "utf8"));

test("only running and lifecycle-paused Goal Loops are restart-resumable", () => {
  assert.equal(isGoalLoopRestartResumable({ status: "running" }), true);
  assert.equal(isGoalLoopRestartResumable({ status: "paused", pauseReason: "" }), true);
  assert.equal(isGoalLoopRestartResumable({ status: "paused", pauseReason: "session_end" }), true);
  assert.equal(isGoalLoopRestartResumable({ status: "paused" }), true);
  for (const pauseReason of ["user", "manual_send", "turn_limit", "unknown_delivery"]) {
    assert.equal(isGoalLoopRestartResumable({ status: "paused", pauseReason }), false);
  }
  for (const status of ["queued", "verifying_completed", "blocked", "completed", "stopped", null]) {
    assert.equal(isGoalLoopRestartResumable({ status }), false);
  }
  assert.equal(isGoalLoopRestartResumable(null), false);
});

test("service construction and skipped candidates do not touch storage", () => {
  let reads = 0;
  const service = new RestartResumeService({
    dataDir: () => { reads += 1; throw new Error("must remain lazy"); },
    orphanedTaskError: orphanError,
  });
  assert.equal(reads, 0);
  assert.deepEqual(service.handleOrphanedTasks([task({ kind: "bot" })], { now: () => NOW, log: () => {} }), []);
  assert.equal(reads, 0);
});

test("existing retry budget format, expiration and persistence survive service recreation", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "restart-resume.json"), JSON.stringify({
    t1: { count: 1, lastAt: NOW },
    old: { count: 2, lastAt: NOW - RESTART_RESUME_WINDOW_MS - 1 },
  }), "utf8");
  assert.equal(await f.service.resumeOrphanedTask(task(), f.deps), true);
  assert.deepEqual(readBudget(f.root), { t1: { count: 2, lastAt: NOW } });
  const restarted = new RestartResumeService({ dataDir: () => f.root, orphanedTaskError: orphanError });
  assert.equal(await restarted.resumeOrphanedTask(task(), f.deps), false);
  assert.equal(f.prompts.length, 1);
  f.deps.now = () => NOW + RESTART_RESUME_WINDOW_MS + 1;
  assert.equal(await restarted.resumeOrphanedTask(task(), f.deps), true);
  assert.deepEqual(readBudget(f.root), { t1: { count: 1, lastAt: f.deps.now() } });
});

test("an unreadable retry budget refuses the resume, is set aside, and the next attempt starts clean", async (t) => {
  const f = fixture(t);
  const file = join(f.root, "restart-resume.json");
  writeFileSync(file, "{torn", "utf8");
  assert.equal(await f.service.resumeOrphanedTask(task(), f.deps), false);
  assert.equal(f.prompts.length, 0);
  assert.equal(existsSync(file), false);
  const kept = readdirSync(f.root).filter((name) => name.startsWith("restart-resume.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(f.root, kept[0]), "utf8"), "{torn");
  assert.equal(await f.service.resumeOrphanedTask(task(), f.deps), true);
  assert.deepEqual(readBudget(f.root), { t1: { count: 1, lastAt: NOW } });
  assert.equal(existsSync(`${file}.lock`), false);
});

test("concurrent processes cannot both claim the last attempt of the budget", { timeout: 25_000 }, async (t) => {
  const f = fixture(t);
  const moduleUrl = new URL("./restart-resume.mjs", import.meta.url).href;
  const code = `
    import { RestartResumeService } from ${JSON.stringify(moduleUrl)};
    const service = new RestartResumeService({ dataDir: () => ${JSON.stringify(f.root)}, orphanedTaskError: "x" });
    let claimed = 0;
    for (let n = 0; n < 5; n += 1) if (service.claimAttempt("shared", ${NOW})) claimed += 1;
    process.stdout.write(String(claimed));
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("exit", (exit) => (exit === 0 ? resolve(Number(out)) : reject(new Error(`exit ${exit}`))));
  });
  const claimed = await Promise.all([run(), run(), run()]);
  // RESTART_RESUME_MAX_ATTEMPTS is 2 across every process together.
  assert.equal(claimed.reduce((sum, value) => sum + value, 0), 2);
  assert.deepEqual(readBudget(f.root), { shared: { count: 2, lastAt: NOW } });
});

test("candidate exclusion and stagger timing are unchanged", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.service.handleOrphanedTasks([
    task({ id: "a", status: "working" }),
    task({ id: "bot", kind: "bot" }),
    task({ id: "managed", botId: "b" }),
    task({ id: "supervised", supervisorBotId: "b" }),
    task({ id: "stale", updatedAt: new Date(NOW - RESTART_RESUME_MAX_STALE_MS - 1).toISOString() }),
    task({ id: "c", status: "working" }),
  ], f.deps), ["a", "c"]);
  assert.deepEqual(f.scheduled.map((s) => s.delayMs), [RESTART_RESUME_DELAY_MS, RESTART_RESUME_DELAY_MS + RESTART_RESUME_STAGGER_MS]);
  assert.equal(f.prompts.length, 0);
  f.deps.getTask = (id) => task({ id });
  f.scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.prompts, [["a", RESTART_RESUME_PROMPT]]);
});

test("user actions and Goal Loop/Room ownership prevent both prompting and budget writes", async (t) => {
  const f = fixture(t);
  for (const current of [undefined, task({ status: "idle" }), task({ error: "other" })]) {
    assert.equal(await f.service.resumeOrphanedTask(task(), { ...f.deps, getTask: () => current }), false);
  }
  assert.equal(await f.service.resumeOrphanedTask(task(), { ...f.deps, isGoalLoopOwned: () => true }), false);
  assert.equal(await f.service.resumeOrphanedTask(task(), { ...f.deps, isRoomDelegated: () => true }), false);
  assert.equal(f.prompts.length, 0);
  assert.equal(existsSync(join(f.root, "restart-resume.json")), false);
});

test("Goal Loop restarts use the dedicated resume path and persist the shared retry budget", async (t) => {
  const f = fixture(t);
  const resumed = [];
  const deps = {
    ...f.deps,
    isGoalLoopOwned: () => true,
    canResumeGoalLoop: () => true,
    resumeGoalLoop: async (...args) => { resumed.push(args); },
  };
  assert.equal(await f.service.resumeOrphanedTask(task(), deps), true);
  assert.deepEqual(resumed, [["t1", RESTART_RESUME_PROMPT]]);
  assert.equal(f.prompts.length, 0, "Goal Loop must not receive a normal prompt");
  assert.deepEqual(readBudget(f.root), { t1: { count: 1, lastAt: NOW } });

  const held = { ...deps, canResumeGoalLoop: () => false };
  assert.equal(await f.service.resumeOrphanedTask(task({ id: "held" }), held), false);
  assert.deepEqual(readBudget(f.root), { t1: { count: 1, lastAt: NOW } });
});

test("unwritable retry budget fails closed without a resend", async (t) => {
  const f = fixture(t);
  const blocked = join(f.root, "not-a-directory");
  writeFileSync(blocked, "occupied", "utf8");
  const service = new RestartResumeService({ dataDir: () => blocked, orphanedTaskError: orphanError });
  assert.equal(await service.resumeOrphanedTask(task(), f.deps), false);
  assert.equal(f.prompts.length, 0);
  assert.match(f.logs[0][0], /could not record the resume attempt/);
});

test("failed prompting still spends the durable retry budget", async (t) => {
  const f = fixture(t);
  const deps = { ...f.deps, promptTask: async () => { throw new Error("provider unavailable"); } };
  assert.equal(await f.service.resumeOrphanedTask(task(), deps), false);
  assert.deepEqual(readBudget(f.root), { t1: { count: 1, lastAt: NOW } });
  assert.match(f.logs[0][0], /resume failed/);
});

test("injected data directories remain isolated without environment configuration", async (t) => {
  const f = fixture(t);
  const other = join(f.root, "another-owner");
  const second = new RestartResumeService({ dataDir: () => other, orphanedTaskError: orphanError });
  await f.service.resumeOrphanedTask(task(), f.deps);
  await f.service.resumeOrphanedTask(task(), f.deps);
  assert.equal(await f.service.resumeOrphanedTask(task(), f.deps), false);
  assert.equal(await second.resumeOrphanedTask(task(), f.deps), true);
  assert.deepEqual(readBudget(other), { t1: { count: 1, lastAt: NOW } });
  assert.deepEqual(readBudget(f.root), { t1: { count: 2, lastAt: NOW } });
});

test("restart resume works in a plain Node process without Next, Web aliases or SDK loading", (t) => {
  const f = fixture(t);
  const moduleUrl = new URL("./restart-resume.mjs", import.meta.url).href;
  const code = `
    import { RestartResumeService } from ${JSON.stringify(moduleUrl)};
    const service = new RestartResumeService({ dataDir: () => ${JSON.stringify(f.root)}, orphanedTaskError: ${JSON.stringify(orphanError)} });
    const task = ${JSON.stringify(task())};
    const result = await service.resumeOrphanedTask(task, {
      getTask: () => task, promptTask: async () => {}, isGoalLoopOwned: () => false,
      isRoomDelegated: () => false, now: () => ${NOW}, log: () => {},
    });
    console.log(JSON.stringify({ result }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5_000 });
  assert.deepEqual(JSON.parse(output), { result: true });
  assert.deepEqual(readBudget(f.root), { t1: { count: 1, lastAt: NOW } });
});

test("the refusal ladder reports the first reason and nothing when resumable", () => {
  const task = { status: "error", error: "orphaned" };
  const base = { task, orphanedTaskError: "orphaned", isRoomDelegated: false, isGoalLoopOwned: false };
  assert.equal(restartResumeRefusal(base), null);
  assert.equal(restartResumeRefusal({ ...base, task: undefined }), "changed");
  assert.equal(restartResumeRefusal({ ...base, task: { status: "working", error: "orphaned" } }), "changed");
  assert.equal(restartResumeRefusal({ ...base, task: { status: "error", error: null } }), "changed");
  assert.equal(restartResumeRefusal({ ...base, task: { status: "error", error: "user stopped it" } }), "changed");
  assert.equal(restartResumeRefusal({ ...base, isRoomDelegated: true }), "room-delegated");
  assert.equal(restartResumeRefusal({ ...base, isGoalLoopOwned: true }), "goal-loop-owned");
  assert.equal(restartResumeRefusal({ ...base, isGoalLoopOwned: true, canResumeGoalLoop: false }), "goal-loop-owned");
  assert.equal(restartResumeRefusal({ ...base, isGoalLoopOwned: true, canResumeGoalLoop: true }), null);
  // A changed task wins over both ownership checks: nothing is resumable anyway.
  assert.equal(restartResumeRefusal({ ...base, task: undefined, isRoomDelegated: true, isGoalLoopOwned: true }), "changed");
  assert.equal(restartResumeRefusal({ ...base, isRoomDelegated: true, isGoalLoopOwned: true }), "room-delegated");
});

test("only an explicit true refuses for Room or Goal Loop ownership", () => {
  const base = { task: { status: "error", error: "orphaned" }, orphanedTaskError: "orphaned" };
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(restartResumeRefusal({ ...base, isRoomDelegated: value, isGoalLoopOwned: false }), null, String(value));
    assert.equal(restartResumeRefusal({ ...base, isRoomDelegated: false, isGoalLoopOwned: value }), null, String(value));
  }
});
