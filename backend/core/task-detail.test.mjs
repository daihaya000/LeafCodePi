import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detailIncludesGoalLoop, detailIncludesMessages, detailStreamingFlag, detailTimeoutError, isDetailTimeoutError,
  liveDetailErrorStatus, liveDetailFlags, offlineDetailFlags, resolveTaskDetailSource,
  shouldSuggestCompaction,
  TASK_DETAIL_OFFLINE_TIMEOUT_MS, TASK_DETAIL_TIMEOUT_MS,
} from "./task-detail.mjs";

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

test("the live budget is longer than the transcript fallback budget", () => {
  assert.equal(TASK_DETAIL_TIMEOUT_MS, 30_000);
  assert.equal(TASK_DETAIL_OFFLINE_TIMEOUT_MS, 10_000);
  assert.ok(TASK_DETAIL_TIMEOUT_MS > TASK_DETAIL_OFFLINE_TIMEOUT_MS);
});

test("a timeout is recognized by its flag, not by its message", () => {
  assert.equal(isDetailTimeoutError(Object.assign(new Error("x"), { timeout: true })), true);
  assert.equal(isDetailTimeoutError(Object.assign(new Error("x"), { timeout: false })), false);
  assert.equal(isDetailTimeoutError(new Error("タスク詳細の取得がタイムアウトしました")), false, "a message alone is not a timeout");
  for (const value of [undefined, null, 0, "timeout"]) {
    assert.equal(isDetailTimeoutError(value), false, String(value));
  }
});

test("each stage names itself and the final failure is a 503", () => {
  assert.deepEqual(detailTimeoutError("live"), {
    message: "タスク詳細の取得がタイムアウトしました", status: 504, timeout: true,
  });
  assert.deepEqual(detailTimeoutError("offline"), {
    message: "オフラインのタスク詳細取得がタイムアウトしました", status: 504, timeout: true,
  });
  assert.deepEqual(detailTimeoutError("final"), {
    message: "タスク詳細を取得できませんでした", status: 503, timeout: true,
  });
  assert.equal(detailTimeoutError("unknown").status, 503, "an unknown stage degrades to the final failure");
});

test("a transcript read never claims compaction and reads a missing retry count as zero", () => {
  assert.deepEqual(offlineDetailFlags({ hangRetryCount: 3, revertLeafId: "leaf-1", manualAbortedAssistantId: "msg-1" }), {
    isCompacting: false, compactionSuggested: false, hangRetryCount: 3, revertLeafId: "leaf-1", manualAbortedAssistantId: "msg-1",
  });
  assert.deepEqual(offlineDetailFlags({}), {
    isCompacting: false, compactionSuggested: false, hangRetryCount: 0, revertLeafId: null, manualAbortedAssistantId: null,
  });
  assert.deepEqual(offlineDetailFlags(undefined), {
    isCompacting: false, compactionSuggested: false, hangRetryCount: 0, revertLeafId: null, manualAbortedAssistantId: null,
  });
});

test("a live read prefers the session values and keeps a stored retry count", () => {
  const task = { hangRetryCount: 2, revertLeafId: "stored-leaf", manualAbortedAssistantId: "stored-msg" };
  assert.deepEqual(liveDetailFlags({ task, live: { hangRetryCount: 5, revertLeafId: "live-leaf", manualAbortedAssistantId: "live-msg" } }), {
    hangRetryCount: 5, revertLeafId: "live-leaf", manualAbortedAssistantId: "live-msg",
  });
  assert.deepEqual(liveDetailFlags({ task, live: { hangRetryCount: 0 } }), {
    hangRetryCount: 2, revertLeafId: "stored-leaf", manualAbortedAssistantId: "stored-msg",
  }, "a live zero must not hide the stored count");
  assert.deepEqual(liveDetailFlags({ task, live: {} }), {
    hangRetryCount: 2, revertLeafId: "stored-leaf", manualAbortedAssistantId: "stored-msg",
  });
  assert.deepEqual(liveDetailFlags({ task: undefined, live: undefined }), {
    hangRetryCount: 0, revertLeafId: null, manualAbortedAssistantId: null,
  });
});

test("only a coded refusal keeps its own status on a failed live read", () => {
  assert.equal(liveDetailErrorStatus(Object.assign(new Error("nope"), { status: 404 })), null);
  assert.equal(liveDetailErrorStatus(Object.assign(new Error("busy"), { status: 409 })), null);
  assert.equal(liveDetailErrorStatus(new Error("boom")), 503);
  assert.equal(liveDetailErrorStatus("boom"), 503);
  assert.equal(liveDetailErrorStatus(undefined), 503);
});

test("messages are included unless the caller says false", () => {
  assert.equal(detailIncludesMessages(true), true);
  assert.equal(detailIncludesMessages(undefined), true);
  assert.equal(detailIncludesMessages(false), false);
  for (const value of [null, 0, "", "false", 1]) {
    assert.equal(detailIncludesMessages(value), true, String(value));
  }
});

test("compaction is never suggested for a Goal Loop-owned session", () => {
  assert.equal(shouldSuggestCompaction({ goalLoopOwned: false, overThreshold: true }), true);
  assert.equal(shouldSuggestCompaction({ goalLoopOwned: false, overThreshold: false }), false);
  assert.equal(shouldSuggestCompaction({ goalLoopOwned: true, overThreshold: true }), false, "the loop compacts natively");
  assert.equal(shouldSuggestCompaction({ goalLoopOwned: true, overThreshold: false }), false);
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(shouldSuggestCompaction({ goalLoopOwned: value, overThreshold: true }), true, String(value));
    assert.equal(shouldSuggestCompaction({ goalLoopOwned: false, overThreshold: value }), false, String(value));
  }
});
