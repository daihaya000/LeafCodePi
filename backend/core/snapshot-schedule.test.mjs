import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySnapshotEvent, NON_RENDERING_SESSION_EVENTS, pendingSnapshotFlush, SNAPSHOT_THROTTLE_MS, THROTTLED_SNAPSHOT_EVENTS,
} from "./snapshot-schedule.mjs";

test("the vocabulary and window are the documented ones", () => {
  assert.deepEqual([...THROTTLED_SNAPSHOT_EVENTS].sort(), ["message_update", "tool_execution_update"]);
  assert.deepEqual([...NON_RENDERING_SESSION_EVENTS].sort(), ["entry_appended", "turn_end", "turn_start"]);
  assert.equal(SNAPSHOT_THROTTLE_MS, 100);
});

test("non-rendering lifecycle events are skipped before anything else", () => {
  for (const eventType of NON_RENDERING_SESSION_EVENTS) {
    assert.deepEqual(classifySnapshotEvent(eventType, undefined), { action: "skip" }, eventType);
    // Even with a pending full snapshot queued, nothing is coalesced into it.
    assert.deepEqual(classifySnapshotEvent(eventType, { eventType: "message_start", isDelta: false }), { action: "skip" }, eventType);
  }
});

test("throttled stream events schedule deltas when nothing full is pending", () => {
  for (const eventType of THROTTLED_SNAPSHOT_EVENTS) {
    assert.deepEqual(classifySnapshotEvent(eventType, undefined), { action: "schedule", isDelta: true }, eventType);
    assert.deepEqual(classifySnapshotEvent(eventType, { eventType: null, isDelta: false }), { action: "schedule", isDelta: true }, eventType);
    // A pending delta is simply replaced by the newer delta.
    assert.deepEqual(classifySnapshotEvent(eventType, { eventType: "message_update", isDelta: true }), { action: "schedule", isDelta: true }, eventType);
  }
});

test("a delta arriving while a full snapshot is queued is coalesced away", () => {
  for (const eventType of THROTTLED_SNAPSHOT_EVENTS) {
    assert.deepEqual(classifySnapshotEvent(eventType, { eventType: "message_start", isDelta: false }), { action: "coalesce" }, eventType);
  }
});

test("other events schedule a full snapshot and replace whatever was pending", () => {
  for (const eventType of ["message_start", "agent_start", "agent_settled", "compaction_end", "some_future_event"]) {
    assert.deepEqual(classifySnapshotEvent(eventType, { eventType: "message_update", isDelta: true }), { action: "schedule", isDelta: false }, eventType);
  }
});

test("the flush uses the pending slot, defaulting to nothing and to not-a-delta", () => {
  assert.deepEqual(pendingSnapshotFlush({ eventType: "message_update", extra: { a: 1 }, isDelta: true }), {
    eventType: "message_update", extra: { a: 1 }, isDelta: true,
  });
  assert.deepEqual(pendingSnapshotFlush({ eventType: null, isDelta: false }), { eventType: null, extra: undefined, isDelta: false });
  assert.deepEqual(pendingSnapshotFlush(undefined), { eventType: null, extra: undefined, isDelta: false });
  // Only the exact true counts as a delta (the flag is read from a mutable slot).
  assert.equal(pendingSnapshotFlush({ eventType: "x", isDelta: "yes" }).isDelta, false);
  assert.equal(pendingSnapshotFlush({ eventType: "x", isDelta: 1 }).isDelta, false);
});

test("a skipped event never sets a pending slot, so nothing is emitted for it", () => {
  // The handler only assigns when the decision schedules; a skip/coalesce leaves the
  // previous pending snapshot untouched, which the flush then reports unchanged.
  const pending = { eventType: "agent_start", extra: { stale: true }, isDelta: false };
  assert.notEqual(classifySnapshotEvent("turn_end", pending).action, "schedule");
  assert.deepEqual(pendingSnapshotFlush(pending), { eventType: "agent_start", extra: { stale: true }, isDelta: false });
});
