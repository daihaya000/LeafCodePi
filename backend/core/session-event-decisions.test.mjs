import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactionFailureMessage, isHarnessAutoCompactionError, shouldApplySettledStatus, shouldSyncTaskFromSessionEvent,
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

test("task sync happens on turn boundaries and on a recorded compaction failure", () => {
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "agent_start" }, false), true);
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "agent_settled" }, false), true);
  assert.equal(shouldSyncTaskFromSessionEvent({ type: "agent_end" }, false), true);
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

test("a settled turn is agent_settled or a final agent_end, unless a transport recovery is pending", () => {
  assert.equal(shouldApplySettledStatus({ type: "agent_settled" }, false), true);
  assert.equal(shouldApplySettledStatus({ type: "agent_end" }, false), true);
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
