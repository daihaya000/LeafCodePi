import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySnapshotEvent, flushPendingSnapshotOnUnsubscribe, NON_RENDERING_SESSION_EVENTS, pendingSnapshotFlush,
  SNAPSHOT_THROTTLE_MS, snapshotOmitsMessages, THROTTLED_SNAPSHOT_EVENTS,
} from "./snapshot-schedule.mjs";

test("metadata-only lifecycle snapshots omit messages; transcript-changing ones keep them", () => {
  for (const type of ["settings_pending", "thinking_level_changed", "project_promoted", "agent_routed", "task_changed", "label_changed"]) {
    assert.equal(snapshotOmitsMessages(type), true, type);
  }
  for (const type of ["prompt_accepted", "abort", "revert", "unrevert", "conversation_reset", "agent_settled", "provider_fallback", "hang_idle"]) {
    assert.equal(snapshotOmitsMessages(type), false, type);
  }
  assert.equal(snapshotOmitsMessages("task_changed", { messages: [] }), false);
  assert.equal(snapshotOmitsMessages("thinking_level_changed", { thinkingLevel: "low" }), true);
});

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

function flushFixture(pending) {
  const calls = [];
  const deps = {
    clearTimer: (timer) => calls.push(`clear:${timer}`),
    clearPending: () => calls.push("clearPending"),
    emitDelta: (eventType) => calls.push(`delta:${eventType}`),
    emitSnapshot: (eventType, extra) => calls.push(`snapshot:${eventType}:${JSON.stringify(extra)}`),
  };
  return { calls, deps, pending };
}

test("unsubscribing without an armed timer does nothing at all", () => {
  for (const pending of [undefined, {}, { eventType: "message_update" }, { timer: null }]) {
    const f = flushFixture(pending);
    assert.equal(flushPendingSnapshotOnUnsubscribe(f.pending, f.deps), false, JSON.stringify(pending));
    assert.deepEqual(f.calls, [], JSON.stringify(pending));
  }
});

test("unsubscribing cancels the timer, then clears the slots, then emits the queued full snapshot", () => {
  const f = flushFixture({ timer: "timer-1", eventType: "agent_start", extra: { a: 1 }, isDelta: false });
  assert.equal(flushPendingSnapshotOnUnsubscribe(f.pending, f.deps), true);
  assert.deepEqual(f.calls, ["clear:timer-1", "clearPending", 'snapshot:agent_start:{"a":1}']);
});

test("a queued delta is emitted as a delta", () => {
  const f = flushFixture({ timer: "timer-2", eventType: "message_update", isDelta: true });
  flushPendingSnapshotOnUnsubscribe(f.pending, f.deps);
  assert.deepEqual(f.calls, ["clear:timer-2", "clearPending", "delta:message_update"]);
});

test("an armed timer with nothing pending is cancelled and cleared without emitting", () => {
  const f = flushFixture({ timer: "timer-3", eventType: null, isDelta: false });
  assert.equal(flushPendingSnapshotOnUnsubscribe(f.pending, f.deps), true);
  assert.deepEqual(f.calls, ["clear:timer-3", "clearPending"]);
});

test("only an exact true marks the queued snapshot as a delta", () => {
  for (const isDelta of ["true", 1, undefined, null]) {
    const f = flushFixture({ timer: "t", eventType: "x", isDelta });
    flushPendingSnapshotOnUnsubscribe(f.pending, f.deps);
    assert.equal(f.calls.at(-1), "snapshot:x:undefined", String(isDelta));
  }
});
