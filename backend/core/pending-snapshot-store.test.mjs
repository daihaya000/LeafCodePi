import assert from "node:assert/strict";
import { test } from "node:test";
import { createPendingSnapshotStore } from "./pending-snapshot-store.mjs";

test("a recorded snapshot is read back with its fields normalized", () => {
  const store = createPendingSnapshotStore();
  assert.equal(store.record("t1", { eventType: "agent_settled", isDelta: true }), true);
  assert.deepEqual(store.read("t1"), { taskId: "t1", eventType: "agent_settled", extra: undefined, isDelta: true });
  assert.equal(store.record("t2", { eventType: "compaction_end", extra: { error: "boom" } }), true);
  assert.deepEqual(store.read("t2"), { taskId: "t2", eventType: "compaction_end", extra: { error: "boom" }, isDelta: false });
  assert.equal(store.read("missing"), null);
});

test("recording without an event type keeps the null default", () => {
  const store = createPendingSnapshotStore();
  store.record("t1", {});
  assert.deepEqual(store.read("t1"), { taskId: "t1", eventType: null, extra: undefined, isDelta: false });
});

test("only an explicit true marks a delta", () => {
  const store = createPendingSnapshotStore();
  for (const value of [undefined, null, 0, "true", 1]) {
    store.record("t1", { eventType: "message_update", isDelta: value });
    assert.equal(store.read("t1").isDelta, false, String(value));
  }
  store.record("t1", { eventType: "message_update", isDelta: true });
  assert.equal(store.read("t1").isDelta, true);
});

test("readers get copies, so a recorded value cannot be mutated from outside", () => {
  const store = createPendingSnapshotStore();
  const extra = { error: "boom" };
  store.record("t1", { eventType: "compaction_end", extra });
  const read = store.read("t1");
  read.eventType = "tampered";
  read.extra.error = "tampered";
  assert.equal(store.read("t1").eventType, "compaction_end");
  assert.deepEqual(store.list()[0].extra, { error: "tampered" }, "the stored extra object is the caller's, only the entry is copied");
  assert.equal(store.list()[0].eventType, "compaction_end");
});

test("re-recording a task replaces its entry and makes it the most recent", () => {
  const store = createPendingSnapshotStore();
  store.record("a", { eventType: "agent_start" });
  store.record("b", { eventType: "agent_start" });
  store.record("a", { eventType: "agent_settled" });
  assert.equal(store.size, 2);
  assert.deepEqual(store.list().map((entry) => [entry.taskId, entry.eventType]), [["b", "agent_start"], ["a", "agent_settled"]]);
});

test("a bounded store evicts the least recently written task", () => {
  const store = createPendingSnapshotStore({ limit: 2 });
  store.record("a", { eventType: "agent_start" });
  store.record("b", { eventType: "agent_start" });
  store.record("c", { eventType: "agent_start" });
  assert.deepEqual(store.list().map((entry) => entry.taskId), ["b", "c"]);
  assert.equal(store.read("a"), null);
  store.record("b", { eventType: "agent_settled" });
  store.record("d", { eventType: "agent_start" });
  assert.deepEqual(store.list().map((entry) => entry.taskId), ["b", "d"]);
});

test("clearing drops one entry and reports whether it was there", () => {
  const store = createPendingSnapshotStore();
  store.record("a", { eventType: "agent_start" });
  assert.equal(store.clear("a"), true);
  assert.equal(store.clear("a"), false);
  assert.equal(store.read("a"), null);
  assert.equal(store.size, 0);
});

test("an unusable task id or a disabled store records nothing", () => {
  assert.equal(createPendingSnapshotStore().record("a", { eventType: "agent_start" }), true, "the default store is enabled");
  assert.equal(createPendingSnapshotStore({ limit: undefined }).record("a", { eventType: "agent_start" }), true, "an undefined limit keeps the default");
  for (const limit of [0, -1, 1.5]) {
    assert.equal(createPendingSnapshotStore({ limit }).record("a", { eventType: "agent_start" }), false, String(limit));
  }
  const store = createPendingSnapshotStore();
  for (const taskId of ["", undefined, null, 42]) {
    assert.equal(store.record(taskId, { eventType: "agent_start" }), false, String(taskId));
  }
  assert.equal(store.size, 0);
});
