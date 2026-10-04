import assert from "node:assert/strict";
import { test } from "node:test";
import { runHangWatchdogAbort, runUserAbort, TASK_NOT_FOUND_MESSAGE } from "./abort-coordinator.mjs";

function fixture({ live = { name: "live" }, task = { id: "task" }, messages = [], abort, onEvent } = {}) {
  const order = [];
  const record = (name, value) => { order.push(name); onEvent?.(name); return value; };
  const persisted = [];
  const warnings = [];
  const deps = {
    disarmHangWatch: (id) => record(`disarm:${id}`),
    clearPendingAttention: (id) => record(`attention:${id}`),
    getLive: () => record("getLive", live ?? undefined),
    clearSessionQueue: () => record("queue"),
    cancelPrompt: () => record("cancelPrompt"),
    cancelPendingSnapshot: () => record("cancelSnapshot"),
    persistManualAbortedAssistantId: (id, value) => { persisted.push(value); record(`persist:${value}`); },
    abortSession: () => record("abort", abort ? abort() : Promise.resolve()),
    snapshotMessages: () => record("snapshot", messages),
    stopGoalLoop: async () => { record("goalLoop"); },
    stopSubagentRuns: async (_live, given) => { record(`subagents:${given.length}`); },
    setIdle: () => record("idle", task ?? undefined),
    releaseLease: () => record("release"),
    emitAbort: () => record("emit"),
    flushRoomMailbox: (botId) => record(`flush:${botId}`),
    warn: (...args) => warnings.push(args),
    toSummary: (value) => ({ summary: value.id }),
  };
  return { order, deps, persisted, warnings };
}

test("a live stop keeps the exact ordering: native abort before projection and slow cleanup", async () => {
  const f = fixture({ messages: [{ role: "user", id: "u" }, { role: "assistant", id: "a" }] });
  assert.deepEqual(await runUserAbort("task", f.deps), { summary: "task" });
  assert.deepEqual(f.order, [
    "disarm:task", "attention:task", "getLive",
    "queue", "cancelPrompt", "cancelSnapshot", "persist:", "abort", "snapshot", "persist:a",
    "goalLoop", "subagents:2", "idle", "release", "emit",
  ]);
  assert.deepEqual(f.persisted, ["", "a"]);
});

test("the final await lets the SDK abort settle before idle is published", async () => {
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  const f = fixture({ abort: () => pending });
  const running = runUserAbort("task", f.deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.order.includes("idle"), false);
  assert.equal(f.order.at(-1), "subagents:0");
  settle();
  await running;
  assert.deepEqual(f.order.slice(-3), ["idle", "release", "emit"]);
});

test("without a live session only durable state is changed and no final snapshot is emitted", async () => {
  const f = fixture({ live: null });
  await runUserAbort("task", f.deps);
  assert.deepEqual(f.order, ["disarm:task", "attention:task", "getLive", "idle", "release"]);
  assert.deepEqual(f.persisted, []);
});

test("a missing task still releases the lease, skips emit and Room flush, then reports 404", async () => {
  const f = fixture({ task: null });
  await assert.rejects(runUserAbort("bot:one:room:main", f.deps), (error) => {
    assert.equal(error.message, TASK_NOT_FOUND_MESSAGE);
    assert.equal(error.status, 404);
    return true;
  });
  assert.deepEqual(f.order.slice(-2), ["idle", "release"]);
  assert.equal(f.order.includes("emit"), false);
  assert.equal(f.order.some((entry) => entry.startsWith("flush:")), false);
});

test("Room stop surfaces a mailbox flush failure after persisting idle", async () => {
  const f = fixture();
  await runUserAbort("bot:one:room:main", f.deps);
  assert.deepEqual(f.order.slice(-2), ["emit", "flush:one"]);
  const failing = fixture();
  const failure = new Error("mailbox unavailable");
  failing.deps.flushRoomMailbox = (botId) => { failing.order.push(`flush:${botId}`); throw failure; };
  await assert.rejects(runUserAbort("bot:one:room:main", failing.deps), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "ROOM_MAILBOX_FLUSH_FAILED");
    assert.match(error.message, /停止は完了しました/);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.deepEqual(failing.order.slice(-4), ["idle", "release", "emit", "flush:one"]);
  assert.deepEqual(failing.warnings, [["[bot-intercom] flush after Room abort failed", failure]]);
  const plain = fixture();
  await runUserAbort("bot:one", plain.deps);
  assert.equal(plain.order.some((entry) => entry.startsWith("flush:")), false);
});

test("cleanup failures still save idle and release the lease before the error propagates", async () => {
  const f = fixture();
  f.deps.stopGoalLoop = async () => { throw new Error("goal stop failed"); };
  await assert.rejects(runUserAbort("task", f.deps), /goal stop failed/);
  assert.equal(f.order.includes("idle"), true);
  assert.equal(f.order.includes("release"), true);
  const snapshotFailing = fixture();
  snapshotFailing.deps.snapshotMessages = () => { throw new Error("snapshot failed"); };
  await assert.rejects(runUserAbort("task", snapshotFailing.deps), /snapshot failed/);
  assert.equal(snapshotFailing.order.includes("idle"), true);
  assert.equal(snapshotFailing.order.includes("release"), true);
});

test("Goal cleanup failure still stops children and waits for the native abort", async () => {
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  const f = fixture({ abort: () => pending });
  f.deps.stopGoalLoop = async () => { throw new Error("goal stop failed"); };
  let finished = false;
  const running = runUserAbort("task", f.deps).catch((error) => { finished = true; return error; });
  await new Promise((resolve) => setImmediate(resolve));
  const premature = finished;
  settle();
  assert.match((await running).message, /goal stop failed/);
  assert.equal(premature, false);
  assert.equal(f.order.includes("subagents:0"), true);
  assert.equal(f.order.includes("idle"), true);
});
test("simultaneous Goal and native abort failures do not leave an unobserved rejection", async () => {
  const f = fixture({ abort: () => Promise.reject(new Error("native abort failed")) });
  f.deps.stopGoalLoop = async () => { throw new Error("goal stop failed"); };
  await assert.rejects(runUserAbort("task", f.deps), /goal stop failed/);
  assert.equal(f.order.includes("subagents:0"), true);
  assert.equal(f.order.includes("idle"), false);
});
test("a synchronous abort failure happens after resumable work was already cleared", async () => {
  const f = fixture();
  f.deps.abortSession = () => { f.order.push("abort"); throw new Error("abort failed"); };
  await assert.rejects(runUserAbort("task", f.deps), /abort failed/);
  assert.deepEqual(f.order.slice(3), ["queue", "cancelPrompt", "cancelSnapshot", "persist:", "abort"]);
  assert.deepEqual(f.persisted, [""]);
});

test("watchdog child cleanup failure still waits for the native abort", async () => {
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  const f = hangFixture({ abort: () => pending });
  f.deps.stopSubagentRuns = async () => { throw new Error("child cleanup failed"); };
  let finished = false;
  const running = runHangWatchdogAbort("task", f.deps).catch((error) => { finished = true; return error; });
  await new Promise((resolve) => setImmediate(resolve));
  const premature = finished;
  settle();
  assert.match((await running).message, /child cleanup failed/);
  assert.equal(premature, false);
});

function hangFixture({ live = { name: "live" }, later, before = 10, after = { startedAt: 10 }, messages = [], abort } = {}) {
  const order = [];
  const persisted = [];
  const warnings = [];
  const deps = {
    getHangWatchStartedAt: () => { order.push("watchStart"); return before; },
    getHangWatch: () => { order.push("watchAfter"); return after; },
    getLive: () => { order.push("getLive"); return order.filter((entry) => entry === "getLive").length > 1 ? later : live; },
    clearPendingAttention: () => order.push("attention"),
    clearSessionQueue: () => order.push("queue"),
    cancelPrompt: () => order.push("cancelPrompt"),
    cancelPendingSnapshot: () => order.push("cancelSnapshot"),
    persistManualAbortedAssistantId: (_id, value) => { persisted.push(value); order.push(`persist:${value}`); },
    abortSession: () => { order.push("abort"); return abort ? abort() : Promise.resolve(); },
    snapshotMessages: () => { order.push("snapshot"); return messages; },
    emitHangAbort: () => order.push("emitHangAbort"),
    stopSubagentRuns: async (_live, given) => { order.push(`subagents:${given.length}`); },
    setIdle: () => order.push("idle"),
    releaseLease: () => order.push("release"),
    emitHangIdle: (value) => order.push(`emitHangIdle:${value?.name}`),
    flushRoomMailbox: (botId) => order.push(`flush:${botId}`),
    warn: (...args) => warnings.push(args),
  };
  return { order, persisted, warnings, deps };
}

test("hang abort captures the watch first, announces hang_abort before cleanup, then idles", async () => {
  const f = hangFixture({ messages: [{ role: "user", id: "u" }, { role: "assistant", id: "a" }] });
  await runHangWatchdogAbort("task", f.deps);
  assert.deepEqual(f.order, [
    "watchStart", "getLive", "attention",
    "queue", "cancelPrompt", "cancelSnapshot", "persist:", "abort", "snapshot", "persist:a",
    "emitHangAbort", "subagents:2", "watchAfter", "idle", "release", "getLive", "emitHangIdle:live",
  ]);
  assert.deepEqual(f.persisted, ["", "a"]);
});

test("hang abort never tears down the Goal Loop or disarms the watch", async () => {
  const f = hangFixture();
  await runHangWatchdogAbort("task", f.deps);
  assert.equal(f.order.some((entry) => /goal|disarm/i.test(entry)), false);
});

test("a watch re-armed by a newer prompt leaves idle, lease, events and Room mailbox untouched", async () => {
  const f = hangFixture({ before: 10, after: { startedAt: 11 } });
  await runHangWatchdogAbort("bot:one:room:main", f.deps);
  assert.deepEqual(f.order.slice(-2), ["subagents:0", "watchAfter"]);
  assert.equal(f.order.some((entry) => ["idle", "release", "flush:one"].includes(entry) || entry.startsWith("emitHangIdle")), false);
});

test("a missing or disarmed watch is not a replacement and the abort completes", async () => {
  for (const options of [{ before: null, after: { startedAt: 3 } }, { before: 10, after: null }]) {
    const f = hangFixture(options);
    await runHangWatchdogAbort("task", f.deps);
    assert.deepEqual(f.order.slice(-4), ["idle", "release", "getLive", "emitHangIdle:live"]);
  }
});

test("hang abort waits for the SDK abort before idle and prefers a newly registered live session", async () => {
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  const f = hangFixture({ abort: () => pending, later: { name: "replacement" } });
  const running = runHangWatchdogAbort("task", f.deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.order.includes("idle"), false);
  settle();
  await running;
  assert.equal(f.order.at(-1), "emitHangIdle:replacement");
});

test("without any live session hang abort still idles durable state but emits nothing", async () => {
  const f = hangFixture({ live: undefined, later: undefined });
  f.deps.getLive = () => { f.order.push("getLive"); return undefined; };
  await runHangWatchdogAbort("task", f.deps);
  assert.deepEqual(f.order, ["watchStart", "getLive", "attention", "watchAfter", "idle", "release", "getLive"]);
  assert.deepEqual(f.persisted, []);
});

test("Room hang aborts flush after idle announcement and only warn when the mailbox fails", async () => {
  const f = hangFixture();
  await runHangWatchdogAbort("bot:one:room:main", f.deps);
  assert.deepEqual(f.order.slice(-2), ["emitHangIdle:live", "flush:one"]);
  const failing = hangFixture();
  const failure = new Error("mailbox unavailable");
  failing.deps.flushRoomMailbox = () => { throw failure; };
  await runHangWatchdogAbort("bot:one:room:main", failing.deps);
  assert.deepEqual(failing.warnings, [["[bot-intercom] flush after Room hang abort failed", failure]]);
});

test("a hang-watch snapshot failure still saves idle and releases the lease after native abort", async () => {
  const f = hangFixture();
  const failure = new Error("snapshot failed");
  f.deps.snapshotMessages = () => { f.order.push("snapshot"); throw failure; };
  await assert.rejects(runHangWatchdogAbort("task", f.deps), (error) => error === failure);
  assert.deepEqual(f.order, [
    "watchStart", "getLive", "attention", "queue", "cancelPrompt", "cancelSnapshot", "persist:",
    "abort", "snapshot", "watchAfter", "idle", "release", "getLive", "emitHangIdle:live",
  ]);
});

test("hang cleanup failures still save idle and release the lease before the error propagates", async () => {
  const f = hangFixture();
  f.deps.stopSubagentRuns = async () => { throw new Error("subagent stop failed"); };
  await assert.rejects(runHangWatchdogAbort("task", f.deps), /subagent stop failed/);
  assert.equal(f.order.includes("idle"), true);
  assert.equal(f.order.includes("release"), true);
  const replaced = hangFixture({ before: 10, after: { startedAt: 99 } });
  replaced.deps.stopSubagentRuns = async () => { throw new Error("subagent stop failed"); };
  await assert.rejects(runHangWatchdogAbort("task", replaced.deps), /subagent stop failed/);
  assert.equal(replaced.order.includes("idle"), false);
});