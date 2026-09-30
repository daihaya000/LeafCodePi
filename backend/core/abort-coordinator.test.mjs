import assert from "node:assert/strict";
import { test } from "node:test";
import { runUserAbort, TASK_NOT_FOUND_MESSAGE } from "./abort-coordinator.mjs";

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

test("Room stops flush the mailbox after publishing, and flush failures are only warned", async () => {
  const f = fixture();
  await runUserAbort("bot:one:room:main", f.deps);
  assert.deepEqual(f.order.slice(-2), ["emit", "flush:one"]);
  const failing = fixture();
  const failure = new Error("mailbox unavailable");
  failing.deps.flushRoomMailbox = () => { throw failure; };
  assert.deepEqual(await runUserAbort("bot:one:room:main", failing.deps), { summary: "task" });
  assert.deepEqual(failing.warnings, [["[bot-intercom] flush after Room abort failed", failure]]);
  const plain = fixture();
  await runUserAbort("bot:one", plain.deps);
  assert.equal(plain.order.some((entry) => entry.startsWith("flush:")), false);
});

test("cleanup failures propagate before idle is saved, matching the original behavior", async () => {
  const f = fixture();
  f.deps.stopGoalLoop = async () => { throw new Error("goal stop failed"); };
  await assert.rejects(runUserAbort("task", f.deps), /goal stop failed/);
  assert.equal(f.order.includes("idle"), false);
  assert.equal(f.order.includes("release"), false);
});

test("a synchronous abort failure happens after resumable work was already cleared", async () => {
  const f = fixture();
  f.deps.abortSession = () => { f.order.push("abort"); throw new Error("abort failed"); };
  await assert.rejects(runUserAbort("task", f.deps), /abort failed/);
  assert.deepEqual(f.order.slice(3), ["queue", "cancelPrompt", "cancelSnapshot", "persist:", "abort"]);
  assert.deepEqual(f.persisted, [""]);
});
