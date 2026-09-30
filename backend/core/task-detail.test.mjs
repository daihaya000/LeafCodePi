import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detailIncludesGoalLoop, detailStreamingFlag, detailTimeoutError, isDetailTimeoutError,
  resolveTaskDetailSource, TASK_DETAIL_OFFLINE_TIMEOUT_MS, TASK_DETAIL_TIMEOUT_MS,
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
