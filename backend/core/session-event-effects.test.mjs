import assert from "node:assert/strict";
import { test } from "node:test";
import { runSessionEventEffects } from "./session-event-effects.mjs";

/** A recording fixture; each hook can be overridden to change its answer. */
function fixture(overrides = {}) {
  const calls = [];
  const task = { id: "task" };
  const deps = {
    trackTurnLifecycleFlags: () => calls.push("lifecycle"),
    trackProviderLimit: () => calls.push("providerLimit"),
    noteWebSocketTransportFailure: () => calls.push("transport"),
    isHarnessAutoCompactionError: () => { calls.push("autoCompaction?"); return false; },
    shouldSyncTaskFromSessionEvent: (harnessAutoCompactionError) => { calls.push(`sync?:${harnessAutoCompactionError}`); return true; },
    getTask: () => { calls.push("getTask"); return task; },
    shouldSkipEventForMissingTask: (syncTask, hasTask) => { calls.push(`skip?:${syncTask}:${hasTask}`); return false; },
    trackThroughputEvent: () => calls.push("throughput"),
    runAgentStartTaskSync: () => { calls.push("agentStartSync"); return true; },
    shouldApplySettledStatus: () => { calls.push("settled?"); return true; },
    applySettledStatus: () => calls.push("applySettled"),
    finishSettledTurn: () => calls.push("finishSettledTurn"),
    compactionFailureMessage: (harnessAutoCompactionError) => { calls.push(`compactionMsg:${harnessAutoCompactionError}`); return undefined; },
    setTaskStatusError: (message) => calls.push(`setError:${message}`),
    patchIdentity: (value) => calls.push(`patchIdentity:${value === task ? "task" : "other"}`),
    scheduleSnapshot: () => calls.push("snapshot"),
    ...overrides,
  };
  return { calls, deps, task };
}

test("a plain event runs every step in the documented order", () => {
  const f = fixture();
  assert.deepEqual(runSessionEventEffects({ type: "message_update" }, f.deps), { stopped: null });
  assert.deepEqual(f.calls, [
    "lifecycle", "providerLimit", "transport",
    "autoCompaction?", "sync?:false", "getTask", "skip?:true:true", "throughput",
    "settled?", "applySettled", "compactionMsg:false", "patchIdentity:task", "snapshot",
  ]);
});

test("an event for a task that is gone stops before throughput tracking", () => {
  const f = fixture({ shouldSkipEventForMissingTask: (syncTask, hasTask) => { fBase.calls.push(`skip?:${syncTask}:${hasTask}`); return true; } });
  const fBase = f;
  assert.deepEqual(runSessionEventEffects({ type: "agent_end" }, f.deps), { stopped: "missing-task" });
  assert.deepEqual(f.calls, ["lifecycle", "providerLimit", "transport", "autoCompaction?", "sync?:false", "getTask", "skip?:true:true"]);
});

test("an event that does not need the task never reads the store", () => {
  const f = fixture({ shouldSyncTaskFromSessionEvent: () => false, getTask: () => { throw new Error("must not read the store"); } });
  assert.deepEqual(runSessionEventEffects({ type: "message_update" }, f.deps), { stopped: null });
  assert.ok(!f.calls.includes("getTask"));
  assert.ok(!f.calls.includes("patchIdentity:task"));
  assert.equal(f.calls.at(-1), "snapshot");
});

test("agent_start claims the lease before settling, and a busy lease stops the event", () => {
  const ok = fixture();
  assert.deepEqual(runSessionEventEffects({ type: "agent_start" }, ok.deps), { stopped: null });
  assert.deepEqual(ok.calls.slice(7), ["throughput", "agentStartSync", "settled?", "applySettled", "compactionMsg:false", "patchIdentity:task", "snapshot"]);
  const busy = fixture({ runAgentStartTaskSync: () => { busyBase.calls.push("agentStartSync"); return false; } });
  const busyBase = busy;
  assert.deepEqual(runSessionEventEffects({ type: "agent_start" }, busy.deps), { stopped: "lease-busy" });
  assert.equal(busy.calls.at(-1), "agentStartSync");
  assert.ok(!busy.calls.some((call) => call.startsWith("patchIdentity")), "nothing is projected for a refused turn start");
});

test("the auto-compaction answer is threaded through sync and the recorded message", () => {
  const f = fixture({
    isHarnessAutoCompactionError: () => { fBase.calls.push("autoCompaction?"); return true; },
    compactionFailureMessage: (owned) => { fBase.calls.push(`compactionMsg:${owned}`); return owned ? "boom" : null; },
  });
  const fBase = f;
  runSessionEventEffects({ type: "compaction_end", errorMessage: "boom" }, f.deps);
  assert.ok(f.calls.includes("sync?:true"));
  assert.ok(f.calls.includes("compactionMsg:true"));
  assert.ok(f.calls.includes("setError:boom"));
});

test("settle handling and the settled-turn finish both run, in that order", () => {
  const f = fixture();
  runSessionEventEffects({ type: "agent_settled" }, f.deps);
  assert.deepEqual(f.calls.slice(9, 13), ["applySettled", "finishSettledTurn", "compactionMsg:false", "patchIdentity:task"]);
  // An event that is not settled still consults the decision, but applies nothing.
  const idle = fixture({ shouldApplySettledStatus: () => false });
  runSessionEventEffects({ type: "message_update" }, idle.deps);
  assert.ok(!idle.calls.includes("applySettled"));
  assert.ok(!idle.calls.includes("finishSettledTurn"));
});

test("a snapshot is always scheduled, even when a lease refusal stopped the write path", () => {
  const busy = fixture({ runAgentStartTaskSync: () => false });
  runSessionEventEffects({ type: "agent_start" }, busy.deps);
  assert.ok(!busy.calls.includes("snapshot"), "a refused turn start does not publish a snapshot");
  const missing = fixture({ shouldSkipEventForMissingTask: () => true });
  runSessionEventEffects({ type: "agent_end" }, missing.deps);
  assert.ok(!missing.calls.includes("snapshot"));
});
