import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { runHangWatchdogAbort, runUserAbort } from "./abort-coordinator.mjs";

function fixture({ failures = new Map(), live = true, abortPromise, replaced = false } = {}) {
  const events = [];
  const session = live ? {} : undefined;
  const task = { id: "task" };
  const record = (name, value) => {
    events.push(name);
    if (failures.has(name)) throw failures.get(name);
    return value;
  };
  const deps = {
    disarmHangWatch: () => record("disarm"),
    clearPendingAttention: () => record("attention"),
    getLive: () => session,
    clearSessionQueue: () => record("queue"),
    cancelPrompt: () => record("cancelPrompt"),
    cancelPendingSnapshot: () => record("cancelSnapshot"),
    persistManualAbortedAssistantId: (_id, assistantId) => record(`persist:${assistantId}`),
    abortSession: () => record("abort", abortPromise ?? Promise.resolve()),
    cancelScheduledResume: async () => record("resumeCancel"),
    snapshotMessages: () => record("snapshot", [{ role: "user", id: "u" }, { role: "assistant", id: "a" }]),
    stopGoalLoop: async () => record("goalLoop"),
    stopSubagentRuns: async (_live, messages) => record(`subagents:${messages.length}`),
    setIdle: () => record("idle", task),
    releaseLease: () => record("release"),
    emitAbort: () => record("emit"),
    emitHangAbort: () => record("emitHangAbort"),
    emitHangIdle: () => record("emitHangIdle"),
    getHangWatchStartedAt: () => 1,
    getHangWatch: () => ({ startedAt: replaced ? 2 : 1 }),
    flushRoomMailbox: () => record("flush"),
    warn: () => record("warn"),
    toSummary: (value) => value,
  };
  return { deps, events };
}

for (const [kind, run, emit] of [
  ["user", runUserAbort, "emit"], ["watchdog", runHangWatchdogAbort, "emitHangIdle"],
]) {
  for (const step of ["attention", "queue", "cancelPrompt", "cancelSnapshot", "persist:"]) {
    test(`${kind}: ${step} failure cannot skip native abort or remaining cleanup`, async () => {
      const failure = new Error(`${step} failed`);
      const f = fixture({ failures: new Map([[step, failure]]) });
      await assert.rejects(run("task", f.deps), (error) => error === failure);
      for (const required of ["queue", "cancelPrompt", "cancelSnapshot", "persist:", "abort", "snapshot", "subagents:2", "idle", "release", emit]) {
        assert.ok(f.events.includes(required), required);
      }
      assert.ok(f.events.indexOf("abort") < f.events.indexOf("snapshot"));
      assert.ok(f.events.indexOf("idle") < f.events.indexOf("release"));
    });
  }

  test(`${kind}: early persistence failure still waits for native abort to settle`, async () => {
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    const failure = new Error("store write failed");
    const f = fixture({ failures: new Map([["persist:", failure]]), abortPromise: pending });
    const rejected = assert.rejects(run("task", f.deps), (error) => error === failure);
    await nextTick();
    const aborted = f.events.includes("abort");
    const idleBeforeAbort = f.events.includes("idle");
    settle();
    await rejected;
    assert.equal(aborted, true);
    assert.equal(idleBeforeAbort, false);
    assert.ok(f.events.includes("release"));
  });

  test(`${kind}: idle persistence failure still releases the lease, without publishing unsaved idle`, async () => {
    const failure = new Error("idle store unavailable");
    const f = fixture({ failures: new Map([["idle", failure]]) });
    await assert.rejects(run("bot:one:room:main", f.deps), (error) => error === failure);
    assert.ok(f.events.includes("abort"));
    assert.ok(f.events.includes("release"));
    assert.equal(f.events.includes(emit), false);
    assert.equal(f.events.includes("flush"), false);
  });

  test(`${kind}: idle persistence failure without a live session still releases its lease`, async () => {
    const failure = new Error("idle store unavailable");
    const f = fixture({ failures: new Map([["idle", failure]]), live: false });
    await assert.rejects(run("task", f.deps), (error) => error === failure);
    assert.deepEqual(f.events.slice(-2), ["idle", "release"]);
  });

  test(`${kind}: multiple cleanup failures retain the first error and never skip lease release`, async () => {
    const failure = new Error("sentinel store failed");
    const f = fixture({ failures: new Map([
      ["persist:", failure], ["idle", new Error("idle failed")], ["warn", new Error("logging failed")],
    ]) });
    await assert.rejects(run("task", f.deps), (error) => error === failure);
    assert.ok(f.events.includes("abort"));
    assert.ok(f.events.includes("release"));
  });

  test(`${kind}: a failed native abort must retain working state and its lease`, async () => {
    const failure = new Error("native abort failed");
    const f = fixture({ abortPromise: Promise.reject(failure) });
    await assert.rejects(run("task", f.deps), (error) => error === failure);
    assert.equal(f.events.includes("idle"), false);
    assert.equal(f.events.includes("release"), false);
    assert.equal(f.events.includes(emit), false);
  });
}

test("user: watchdog persistence failure cannot prevent a requested stop", async () => {
  const failure = new Error("watch store unavailable");
  const f = fixture({ failures: new Map([["disarm", failure]]) });
  await assert.rejects(runUserAbort("task", f.deps), (error) => error === failure);
  for (const step of ["attention", "abort", "goalLoop", "subagents:2", "idle", "release", "emit"]) {
    assert.ok(f.events.includes(step), step);
  }
});

for (const step of ["snapshot", "persist:a", "emitHangAbort"]) {
  test(`watchdog: ${step} failure cannot prevent detached child cleanup`, async () => {
    const failure = new Error(`${step} failed`);
    const f = fixture({ failures: new Map([[step, failure]]) });
    await assert.rejects(runHangWatchdogAbort("task", f.deps), (error) => error === failure);
    assert.ok(f.events.includes("emitHangAbort"));
    assert.ok(f.events.includes(step === "snapshot" ? "subagents:0" : "subagents:2"));
    assert.deepEqual(f.events.slice(-3), ["idle", "release", "emitHangIdle"]);
  });
}

test("watchdog: early cleanup failure never tears down a replacement turn", async () => {
  const failure = new Error("sentinel failed");
  const f = fixture({ failures: new Map([["persist:", failure]]), replaced: true });
  await assert.rejects(runHangWatchdogAbort("task", f.deps), (error) => error === failure);
  assert.ok(f.events.includes("abort"));
  for (const step of ["idle", "release", "emitHangIdle", "flush"]) assert.equal(f.events.includes(step), false);
});
