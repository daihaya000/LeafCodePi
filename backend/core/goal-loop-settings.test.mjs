import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampGoalLoopCooldownSeconds, clampGoalLoopMaxTurns, DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS,
  DEFAULT_GOAL_LOOP_MAX_TURNS, formatGoalLoopCooldownSeconds, GOAL_LOOP_LIVE_STATUSES,
  isGoalLoopControlAction, isGoalLoopLiveStatus, isGoalLoopSessionOwnedStatus,
  MAX_GOAL_LOOP_ACCEPTANCE_ITEMS,
  MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS, MAX_GOAL_LOOP_COOLDOWN_SECONDS, MAX_GOAL_LOOP_TURNS,
  nextGoalLoopTurn, normalizeGoalLoopAcceptance, normalizeGoalLoopMaxTurns, parseGoalLoopCooldownSeconds,
  shouldRollbackStaleGoalPrepare,
} from "./goal-loop-settings.mjs";

test("the documented defaults and bounds are unchanged", () => {
  assert.equal(DEFAULT_GOAL_LOOP_MAX_TURNS, 0);
  assert.equal(MAX_GOAL_LOOP_TURNS, 100);
  assert.equal(DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS, 0);
  assert.equal(MAX_GOAL_LOOP_COOLDOWN_SECONDS, 24 * 60 * 60);
  assert.equal(MAX_GOAL_LOOP_ACCEPTANCE_ITEMS, 10);
  assert.equal(MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS, 2_000);
  assert.deepEqual([...GOAL_LOOP_LIVE_STATUSES], ["queued", "running", "verifying_completed"]);
});

test("live statuses are the turn-owning ones, owned statuses add the operator holds", () => {
  for (const status of GOAL_LOOP_LIVE_STATUSES) {
    assert.equal(isGoalLoopLiveStatus(status), true, status);
    assert.equal(isGoalLoopSessionOwnedStatus(status), true, status);
  }
  assert.equal(isGoalLoopLiveStatus("paused"), false);
  assert.equal(isGoalLoopSessionOwnedStatus("paused"), true);
  assert.equal(isGoalLoopLiveStatus("blocked"), false);
  assert.equal(isGoalLoopSessionOwnedStatus("blocked"), true);
  for (const terminal of ["completed", "failed", "cancelled", "idle", ""]) {
    assert.equal(isGoalLoopLiveStatus(terminal), false, terminal);
    assert.equal(isGoalLoopSessionOwnedStatus(terminal), false, terminal);
  }
  for (const empty of [null, undefined]) {
    assert.equal(isGoalLoopLiveStatus(empty), false);
    assert.equal(isGoalLoopSessionOwnedStatus(empty), false);
  }
});

test("the next queued turn does not consume a retried interrupted turn", () => {
  assert.equal(nextGoalLoopTurn({ status: "queued", turnCount: 2 }), 3);
  assert.equal(nextGoalLoopTurn({ status: "queued", turnCount: 2, retryInterruptedTurn: true }), 2);
  assert.equal(nextGoalLoopTurn({ status: "running", turnCount: 2 }), 2);
  assert.equal(nextGoalLoopTurn({ status: null, turnCount: null }), 0);
  assert.equal(nextGoalLoopTurn({}), 0);
  assert.equal(nextGoalLoopTurn({ turnCount: -5 }), 0);
  assert.equal(nextGoalLoopTurn({ turnCount: 2.9 }), 2);
});

test("JSON result retries show the same turn the scheduler will resend", () => {
  assert.equal(nextGoalLoopTurn({ status: "queued", turnCount: 2, unreadableStreak: 1 }), 2);
  assert.equal(nextGoalLoopTurn({ status: "queued", turnCount: 2, unreadableStreak: 0 }), 3);
  assert.equal(nextGoalLoopTurn({ status: "verifying_completed", turnCount: 2, unreadableStreak: 1 }), 2);
});

test("max turns normalize to null (no limit) or a bounded integer", () => {
  for (const value of [null, undefined, "", "   ", "abc", Infinity, NaN]) {
    assert.equal(normalizeGoalLoopMaxTurns(value), null, String(value));
  }
  assert.equal(normalizeGoalLoopMaxTurns(0), 0);
  assert.equal(normalizeGoalLoopMaxTurns("12"), 12);
  assert.equal(normalizeGoalLoopMaxTurns(3.9), 3);
  assert.equal(normalizeGoalLoopMaxTurns(-4), 0);
  assert.equal(normalizeGoalLoopMaxTurns(MAX_GOAL_LOOP_TURNS + 50), MAX_GOAL_LOOP_TURNS);
  assert.equal(clampGoalLoopMaxTurns(null), DEFAULT_GOAL_LOOP_MAX_TURNS);
  assert.equal(clampGoalLoopMaxTurns(undefined, 7), 7);
  assert.equal(clampGoalLoopMaxTurns(0), 0);
});

test("acceptance lists are trimmed and bounded, and reject bad shapes instead of trimming them", () => {
  assert.deepEqual(normalizeGoalLoopAcceptance(undefined), []);
  assert.deepEqual(normalizeGoalLoopAcceptance(null), []);
  assert.deepEqual(normalizeGoalLoopAcceptance([]), []);
  assert.deepEqual(normalizeGoalLoopAcceptance([" a ", "b", "   "]), ["a", "b"]);
  assert.equal(normalizeGoalLoopAcceptance("nope"), null);
  assert.equal(normalizeGoalLoopAcceptance([1]), null);
  assert.equal(normalizeGoalLoopAcceptance(Array(MAX_GOAL_LOOP_ACCEPTANCE_ITEMS + 1).fill("x")), null);
  assert.equal(normalizeGoalLoopAcceptance(Array(MAX_GOAL_LOOP_ACCEPTANCE_ITEMS).fill("x")).length, MAX_GOAL_LOOP_ACCEPTANCE_ITEMS);
  assert.equal(normalizeGoalLoopAcceptance(["x".repeat(MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS + 1)]), null);
  assert.equal(normalizeGoalLoopAcceptance(["x".repeat(MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS)])[0].length, MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS);
});

test("cooldown input accepts numbers, plain seconds and d/h/m/s tokens", () => {
  assert.equal(parseGoalLoopCooldownSeconds(90), 90);
  assert.equal(parseGoalLoopCooldownSeconds("90"), 90);
  assert.equal(parseGoalLoopCooldownSeconds("-5"), -5);
  assert.equal(parseGoalLoopCooldownSeconds("1.5"), 1.5);
  assert.equal(parseGoalLoopCooldownSeconds("1h"), 3_600);
  assert.equal(parseGoalLoopCooldownSeconds("1h 30m"), 3_600 + 1_800);
  assert.equal(parseGoalLoopCooldownSeconds("2d 3h 4m 5s"), 2 * 86_400 + 3 * 3_600 + 4 * 60 + 5);
  assert.equal(parseGoalLoopCooldownSeconds("30S"), 30);
});

test("malformed cooldown input falls back to the default instead of guessing", () => {
  for (const value of [undefined, null, true, {}, [], "", "   ", "abc", "1x", "1h 1x", "5m 1", "h1"]) {
    assert.equal(parseGoalLoopCooldownSeconds(value), DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS, JSON.stringify(value));
  }
});

test("cooldowns clamp into range and format back into the token form", () => {
  assert.equal(clampGoalLoopCooldownSeconds("1h"), 3_600);
  assert.equal(clampGoalLoopCooldownSeconds(-10), 0);
  assert.equal(clampGoalLoopCooldownSeconds(MAX_GOAL_LOOP_COOLDOWN_SECONDS + 10), MAX_GOAL_LOOP_COOLDOWN_SECONDS);
  assert.equal(clampGoalLoopCooldownSeconds("abc"), 0);
  assert.equal(formatGoalLoopCooldownSeconds(0), "0");
  assert.equal(formatGoalLoopCooldownSeconds(3_600), "1h");
  assert.equal(formatGoalLoopCooldownSeconds(3_600 + 1_800 + 5), "1h 30m 5s");
  assert.equal(formatGoalLoopCooldownSeconds(86_400), "1d");
  // The cap applies before formatting, so a larger value formats as the cap.
  assert.equal(formatGoalLoopCooldownSeconds(2 * 86_400 + 3 * 3_600), "1d");
  assert.equal(formatGoalLoopCooldownSeconds(90), "1m 30s");
  assert.equal(formatGoalLoopCooldownSeconds(30), "30s");
  // Round-trips through parsing, and clamps first like the original.
  assert.equal(formatGoalLoopCooldownSeconds(MAX_GOAL_LOOP_COOLDOWN_SECONDS + 10), "1d");
});

test("only pause, stop and complete are control actions", () => {
  for (const action of ["pause", "stop", "complete"]) {
    assert.equal(isGoalLoopControlAction(action), true, action);
  }
  for (const action of ["start", "resume", "", "PAUSE", undefined, null]) {
    assert.equal(isGoalLoopControlAction(action), false, String(action));
  }
});

test("a stale start/resume rolls back only its own preparation", () => {
  const base = {
    isStartOrResume: true, ownsLease: true, taskStatus: "working",
    promptActive: false, isStreaming: false, isCompacting: false,
  };
  assert.equal(shouldRollbackStaleGoalPrepare(base), true);
  assert.equal(shouldRollbackStaleGoalPrepare({ ...base, isStartOrResume: false }), false, "a control action keeps its state");
  assert.equal(shouldRollbackStaleGoalPrepare({ ...base, ownsLease: false }), false, "another worker owns the lease now");
  assert.equal(shouldRollbackStaleGoalPrepare({ ...base, taskStatus: "idle" }), false);
  assert.equal(shouldRollbackStaleGoalPrepare({ ...base, taskStatus: undefined }), false);
  assert.equal(shouldRollbackStaleGoalPrepare({ ...base, promptActive: true }), false);
  assert.equal(shouldRollbackStaleGoalPrepare({ ...base, isStreaming: true }), false);
  assert.equal(shouldRollbackStaleGoalPrepare({ ...base, isCompacting: true }), false);
});

test("only an explicit true counts as running or owning in the rollback check", () => {
  const base = {
    isStartOrResume: true, ownsLease: true, taskStatus: "working",
    promptActive: false, isStreaming: false, isCompacting: false,
  };
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(shouldRollbackStaleGoalPrepare({ ...base, isStartOrResume: value }), false, String(value));
    assert.equal(shouldRollbackStaleGoalPrepare({ ...base, ownsLease: value }), false, String(value));
    assert.equal(shouldRollbackStaleGoalPrepare({ ...base, promptActive: value }), true, String(value));
    assert.equal(shouldRollbackStaleGoalPrepare({ ...base, isStreaming: value }), true, String(value));
    assert.equal(shouldRollbackStaleGoalPrepare({ ...base, isCompacting: value }), true, String(value));
  }
});
