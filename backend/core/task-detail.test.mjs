import assert from "node:assert/strict";
import { test } from "node:test";
import { detailIncludesGoalLoop, detailStreamingFlag, resolveTaskDetailSource } from "./task-detail.mjs";

test("an archived task always reads its stored transcript", () => {
  assert.equal(resolveTaskDetailSource({ isArchived: true, isForeignLease: false, offline: false }), "archived");
  assert.equal(resolveTaskDetailSource({ isArchived: true, isForeignLease: true, offline: true }), "archived");
});

test("an offline read or another worker's lease reads the transcript", () => {
  const base = { isArchived: false, isForeignLease: false, offline: false };
  assert.equal(resolveTaskDetailSource(base), "live");
  assert.equal(resolveTaskDetailSource({ ...base, offline: true }), "offline");
  assert.equal(resolveTaskDetailSource({ ...base, isForeignLease: true }), "offline");
  assert.equal(resolveTaskDetailSource({ ...base, offline: true, isForeignLease: true }), "offline");
});

test("only an explicit true selects a source, so a missing flag reads live", () => {
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(resolveTaskDetailSource({ isArchived: value, isForeignLease: false, offline: false }), "live", String(value));
    assert.equal(resolveTaskDetailSource({ isArchived: false, isForeignLease: value, offline: false }), "live", String(value));
    assert.equal(resolveTaskDetailSource({ isArchived: false, isForeignLease: false, offline: value }), "live", String(value));
  }
});

test("the streaming flag follows the source, and a live read keeps the caller's value", () => {
  assert.equal(detailStreamingFlag("archived", "working"), false, "an archived task is never streaming");
  assert.equal(detailStreamingFlag("offline", "working"), true);
  assert.equal(detailStreamingFlag("offline", "idle"), false);
  assert.equal(detailStreamingFlag("offline", undefined), false);
  assert.equal(detailStreamingFlag("live", "working"), null, "the live session decides");
});

test("only the archived payload omits the Goal Loop state", () => {
  assert.equal(detailIncludesGoalLoop("archived"), false);
  assert.equal(detailIncludesGoalLoop("offline"), true);
  assert.equal(detailIncludesGoalLoop("live"), true);
});
