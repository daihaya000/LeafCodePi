import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactionFailureMessage, isHarnessAutoCompactionError, runAgentStartTaskSync, shouldApplySettledStatus,
  shouldSkipEventForMissingTask, shouldSyncTaskFromSessionEvent,
} from "./session-event-decisions.mjs";

test("automatic compaction errors need a compaction failure plus a harness-owned promise", () => {
  const failure = { type: "compaction_end", errorMessage: "boom" };
  assert.equal(isHarnessAutoCompactionError(failure, true), true);
  assert.equal(isHarnessAutoCompactionError(failure, false), false);
  assert.equal(isHarnessAutoCompactionError({ ...failure, aborted: true }, true), false);
  assert.equal(isHarnessAutoCompactionError({ type: "compaction_end" }, true), false);
  assert.equal(isHarnessAutoCompactionError({ type: "agent_end", errorMessage: "boom" }, true), false);
  assert.equal(isHarnessAutoCompactionError(undefined, true), false);
});

test("task sync happens on actual run boundaries and on a recorded compaction failure", () => {
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "agent_start" }, false), true);
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "agent_settled" }, false), true);
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "agent_end" }, false), false);
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "agent_end", willRetry: false }, false), false);
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "agent_end", willRetry: true }, false), false);
  // A manual compaction failure is not the harness's, so nothing is synced.
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "compaction_end", errorMessage: "x", reason: "manual" }, false), false);
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "compaction_end", errorMessage: "x", reason: "manual" }, true), true);
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "compaction_end", errorMessage: "x", reason: "auto" }, false), true);
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "compaction_end", errorMessage: "x", aborted: true, reason: "auto" }, false), false);
  for (const type of ["message_update", "tool_start", "turn_start", "compaction_start"]) {
    assert.equal(shouldSyncTaskFromSessionEvent({ type }, false), false, type);
  }
});

test("only agent_settled releases the run, unless a transport recovery is pending", () => {
  assert.equal(shouldApplySettledStatus({ type: "agent_settled" }, false), true);
  // agent_end still precedes extension settlement writes and possible continuations.
  assert.equal(shouldApplySettledStatus({ type: "agent_end" }, false), false);
  assert.equal(shouldApplySettledStatus({ type: "agent_end", willRetry: false }, false), false);
  assert.equal(shouldApplySettledStatus({ type: "agent_end", willRetry: true }, false), false);
  assert.equal(shouldApplySettledStatus({ type: "message_update" }, false), false);
  assert.equal(shouldApplySettledStatus({ type: "agent_settled" }, true), false);
  assert.equal(shouldApplySettledStatus({ type: "agent_end" }, true), false);
});

test("only non-manual (or harness-owned) compaction failures produce a message", () => {
  assert.equal(compactionFailureMessage({ type: "compaction_end", errorMessage: "boom", reason: "auto" }, false), "boom");
  assert.equal(compactionFailureMessage({ type: "compaction_end", errorMessage: "boom", reason: "manual" }, false), null);
  assert.equal(compactionFailureMessage({ type: "compaction_end", errorMessage: "boom", reason: "manual" }, true), "boom");
  assert.equal(compactionFailureMessage({ type: "compaction_end", errorMessage: "boom" }, false), "boom");
  assert.equal(compactionFailureMessage({ type: "compaction_end", errorMessage: "boom", aborted: true }, false), null);
  assert.equal(compactionFailureMessage({ type: "agent_end", errorMessage: "boom" }, false), null);
  assert.equal(compactionFailureMessage({ type: "compaction_end" }, false), null);
});

test("the same failure classified with the same inputs always decides the same way", () => {
  const failure = { type: "compaction_end", errorMessage: "same", reason: "manual" };
  const harnessOwned = isHarnessAutoCompactionError(failure, true);
  assert.equal(shouldSyncTaskFromSessionEvent(failure, harnessOwned), true);
  assert.equal(compactionFailureMessage(failure, harnessOwned), "same");
  assert.equal(shouldSyncTaskFromSessionEvent(failure, false), false);
  assert.equal(compactionFailureMessage(failure, false), null);
});

test("an event that wants the task is dropped when the task row is gone", () => {
  assert.equal(shouldSkipEventForMissingTask(true, false), true);
  assert.equal(shouldSkipEventForMissingTask(true, true), false);
  // Events that do not touch the task keep flowing even with no row.
  assert.equal(shouldSkipEventForMissingTask(false, false), false);
  assert.equal(shouldSkipEventForMissingTask(false, true), false);
});

test("agent_start claims the lease before publishing the task as working", () => {
  const calls = [];
  const deps = {
    acquireLease: (taskId) => { calls.push(`lease:${taskId}`); return true; },
    setStatus: (taskId, status) => { calls.push(`${status}:${taskId}`); },
    busyMessage: "busy",
  };
  assert.equal(runAgentStartTaskSync("task", deps), true);
  assert.deepEqual(calls, ["lease:task", "working:task"]);
});

test("a lease held elsewhere marks the task failed and stops the event", () => {
  const calls = [];
  const deps = {
    acquireLease: () => { calls.push("lease"); return false; },
    setStatus: (taskId, status, error) => { calls.push(`${status}:${taskId}:${error}`); },
    busyMessage: "別のワーカーで実行中です",
  };
  assert.equal(runAgentStartTaskSync("task", deps), false);
  assert.deepEqual(calls, ["lease", "error:task:別のワーカーで実行中です"]);
});

test("a lease throw surfaces without marking the task and never publishes working", () => {
  const calls = [];
  const deps = {
    acquireLease: () => { throw new Error("lease store down"); },
    setStatus: (_taskId, status) => { calls.push(status); },
    busyMessage: "busy",
  };
  assert.throws(() => runAgentStartTaskSync("task", deps), /lease store down/);
  assert.deepEqual(calls, []);
});
