import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isRoutineDue, isTransientRoutineStartError, nextRoutineFailureState, routineAutoDisabled,
  runSchedulerTick, tryAcquireSchedulerLock,
} from "./routine-scheduler.mjs";
import { cronMatches as routineScheduleCronMatches } from "./routine-schedule.mjs";

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-routine-scheduler-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("the scheduler lock is exclusive, creates its parent, and is reclaimed only when stale", (t) => {
  const root = tempRoot(t);
  const options = { lockPath: join(root, "bots", "routines.scheduler.lock"), parentDir: join(root, "bots"), staleMs: 30_000 };
  assert.equal(tryAcquireSchedulerLock(options), options.lockPath);
  assert.equal(tryAcquireSchedulerLock(options), undefined);
  const old = new Date(Date.now() - 60_000);
  utimesSync(options.lockPath, old, old);
  assert.equal(tryAcquireSchedulerLock(options), options.lockPath);
  assert.equal(tryAcquireSchedulerLock(options), undefined);
});

test("stale detection reads the injected clock at call time and keeps a fresh foreign lock", (t) => {
  const root = tempRoot(t);
  const options = { lockPath: join(root, "lock"), parentDir: root, staleMs: 30_000 };
  mkdirSync(options.lockPath);
  let now = Date.now();
  assert.equal(tryAcquireSchedulerLock({ ...options, now: () => now }), undefined);
  now += 30_001 + 1_000;
  assert.equal(tryAcquireSchedulerLock({ ...options, now: () => now }), options.lockPath);
});

test("an unusable parent directory surfaces its error before any lock is created, as the parent mkdir sits outside the lock attempt", (t) => {
  const root = tempRoot(t);
  const lockPath = join(root, "missing-parent", "x", "lock");
  assert.throws(() => tryAcquireSchedulerLock({ lockPath, parentDir: join(root, "file\0bad"), staleMs: 1 }));
  assert.equal(existsSync(lockPath), false);
});

const always = () => true;
test("routine due decision: enabled, cron match, and minimum interval since the last run", () => {
  const base = { minute: new Date(2024, 0, 1, 0, 5), nowMs: Date.UTC(2024, 0, 1, 0, 5), minIntervalMs: 300_000, cronMatches: always };
  const routine = { id: "r", enabled: true, schedule: "*/5 * * * *", lastRunAt: null };
  assert.equal(isRoutineDue(routine, base), true);
  assert.equal(isRoutineDue({ ...routine, enabled: false }, base), false);
  assert.equal(isRoutineDue(routine, { ...base, cronMatches: () => false }), false);
  assert.equal(isRoutineDue({ ...routine, lastRunAt: new Date(base.nowMs - 299_999).toISOString() }, base), false);
  assert.equal(isRoutineDue({ ...routine, lastRunAt: new Date(base.nowMs - 300_000).toISOString() }, base), true);
  assert.equal(isRoutineDue({ ...routine, lastRunAt: "not a date" }, base), true);
  assert.equal(isRoutineDue({ ...routine, lastRunAt: "" }, base), true);
});

test("an unparsable schedule is never due and never aborts the tick", () => {
  const base = { minute: new Date(2024, 0, 1, 0, 5), nowMs: 1, minIntervalMs: 300_000, cronMatches: () => true };
  // With the core matcher (the default), an unparsable schedule is simply not due.
  const coreMatcher = routineScheduleCronMatches;
  assert.equal(isRoutineDue({ id: "r", enabled: true, schedule: "nonsense", lastRunAt: null }, { ...base, cronMatches: coreMatcher }), false);
  assert.equal(isRoutineDue({ id: "r", enabled: true, schedule: "5 0 * * *", lastRunAt: null }, { ...base, cronMatches: coreMatcher }), true);
  // A matcher that throws is contained instead of aborting the tick.
  assert.equal(isRoutineDue({ id: "r", enabled: true, schedule: "nonsense", lastRunAt: null }, { ...base, cronMatches: () => { throw new Error("bad cron"); } }), false);
  // A disabled routine is skipped before the cron is consulted at all.
  assert.equal(isRoutineDue({ id: "r", enabled: false, schedule: "nonsense" }, { ...base, cronMatches: () => { throw new Error("must not be called"); } }), false);
});

test("cron is evaluated against the minute with seconds and milliseconds cleared", () => {
  const seen = [];
  isRoutineDue({ id: "r", enabled: true, schedule: "* * * * *" }, {
    minute: new Date(2024, 0, 1, 0, 5), nowMs: 0, minIntervalMs: 1, cronMatches: (schedule, minute) => { seen.push([schedule, minute.getTime()]); return true; },
  });
  assert.deepEqual(seen, [["* * * * *", new Date(2024, 0, 1, 0, 5).getTime()]]);
});

function tickFixture(overrides = {}) {
  const events = [];
  const deps = {
    acquireLock: () => { events.push("acquire"); return "lock"; },
    releaseLock: (lock) => events.push(`release:${lock}`),
    listBots: () => [{ id: "on", enabled: true }, { id: "off", enabled: false }],
    listRoutines: (botId) => { events.push(`list:${botId}`); return [{ id: `${botId}-r`, enabled: true, schedule: "s", lastRunAt: null }]; },
    cronMatches: (_schedule, minute) => { events.push(`minute:${minute.getSeconds()}:${minute.getMilliseconds()}`); return true; },
    minIntervalMs: 300_000,
    runRoutine: (botId, routineId) => { events.push(`run:${botId}:${routineId}`); return Promise.resolve(); },
    ...overrides,
  };
  return { events, deps };
}

test("a tick skips disabled bots, truncates the minute, starts due routines synchronously, and releases after starting", async () => {
  const f = tickFixture();
  await runSchedulerTick(f.deps, new Date(2024, 0, 1, 0, 5, 42, 500));
  assert.deepEqual(f.events, ["acquire", "list:on", "minute:0:0", "run:on:on-r", "release:lock"]);
});

test("a tick without the lock does nothing, and a failing list still releases the lock", async () => {
  const f = tickFixture({ acquireLock: () => undefined });
  await runSchedulerTick(f.deps);
  assert.deepEqual(f.events, []);
  const g = tickFixture({ listBots: () => { throw new Error("bots unreadable"); } });
  await assert.rejects(runSchedulerTick(g.deps), /bots unreadable/);
  assert.deepEqual(g.events, ["acquire", "release:lock"]);
});

test("routine failures are detached: rejections are swallowed and later routines still start", async () => {
  const started = [];
  const f = tickFixture({
    listBots: () => [{ id: "b", enabled: true }],
    listRoutines: () => [
      { id: "sync-throw", enabled: true, schedule: "s" },
      { id: "async-reject", enabled: true, schedule: "s" },
      { id: "ok", enabled: true, schedule: "s" },
    ],
    runRoutine: (_bot, id) => {
      started.push(id);
      if (id === "sync-throw") throw new Error("sync");
      if (id === "async-reject") return Promise.reject(new Error("async"));
      return Promise.resolve();
    },
  });
  await runSchedulerTick(f.deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["sync-throw", "async-reject", "ok"]);
});

test("without an injected matcher the core cron implementation is used", async () => {
  const started = [];
  const deps = {
    acquireLock: () => "lock",
    releaseLock: () => undefined,
    listBots: () => [{ id: "b", enabled: true }],
    listRoutines: () => [
      { id: "daily-9", enabled: true, schedule: "0 9 * * *" },
      { id: "daily-10", enabled: true, schedule: "0 10 * * *" },
      { id: "broken", enabled: true, schedule: "nonsense" },
    ],
    minIntervalMs: 300_000,
    runRoutine: (_botId, routineId) => { started.push(routineId); },
  };
  await runSchedulerTick(deps, new Date(2026, 0, 5, 9, 0));
  assert.deepEqual(started, ["daily-9"]);
  started.length = 0;
  await runSchedulerTick(deps, new Date(2026, 0, 5, 10, 0));
  assert.deepEqual(started, ["daily-10"], "an unparsable schedule never starts a run");
});

test("the lock is released before a long-running routine finishes", async () => {
  let finish;
  const events = [];
  const f = tickFixture({
    listBots: () => [{ id: "b", enabled: true }],
    listRoutines: () => [{ id: "slow", enabled: true, schedule: "s" }],
    runRoutine: () => new Promise((resolve) => { finish = () => { events.push("finished"); resolve(); }; }),
    releaseLock: () => events.push("released"),
  });
  await runSchedulerTick(f.deps);
  assert.deepEqual(events, ["released"]);
  finish();
});

test("a failed run counts up and disables only at the limit", () => {
  const max = 3;
  let state = { failureCount: 0, enabled: true };
  state = nextRoutineFailureState(state, max);
  assert.deepEqual(state, { failureCount: 1, enabled: true });
  state = nextRoutineFailureState(state, max);
  assert.deepEqual(state, { failureCount: 2, enabled: true });
  state = nextRoutineFailureState(state, max);
  assert.deepEqual(state, { failureCount: 3, enabled: false });
  state = nextRoutineFailureState(state, max);
  assert.deepEqual(state, { failureCount: 4, enabled: false });
});

test("a failure never re-enables a disabled routine or loses a count", () => {
  assert.deepEqual(nextRoutineFailureState({ failureCount: 1, enabled: false }, 3), { failureCount: 2, enabled: false });
  assert.deepEqual(nextRoutineFailureState({ failureCount: 5, enabled: true }, 3), { failureCount: 6, enabled: false });
  assert.deepEqual(nextRoutineFailureState(undefined, 3), { failureCount: 1, enabled: false }, "a missing record counts as disabled");
  assert.deepEqual(nextRoutineFailureState({}, 3), { failureCount: 1, enabled: false });
  assert.deepEqual(nextRoutineFailureState({ failureCount: 2 }, 1), { failureCount: 3, enabled: false });
});

test("the auto-disable note appears exactly at the limit", () => {
  assert.equal(routineAutoDisabled(0, 3), false);
  assert.equal(routineAutoDisabled(2, 3), false);
  assert.equal(routineAutoDisabled(3, 3), true);
  assert.equal(routineAutoDisabled(4, 3), true);
});

test("only the lost worker race is transient", () => {
  assert.equal(isTransientRoutineStartError(new Error("タスクは別のワーカーで実行中です")), true);
  assert.equal(isTransientRoutineStartError(Object.assign(new Error("タスクは別のワーカーで実行中です"), { status: 409 })), true);
  assert.equal(isTransientRoutineStartError(new Error("Bot の実行に失敗しました")), false);
  assert.equal(isTransientRoutineStartError("タスクは別のワーカーで実行中です"), true, "a string error is read the same way");
  assert.equal(isTransientRoutineStartError(undefined), false);
});
