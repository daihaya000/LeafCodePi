import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  extractGoalResult,
  jsonObjectCandidates,
  applyResult,
  normalizeAcceptance,
} from "./index.ts";

test("extracts the last valid structured result", () => {
  const result = extractGoalResult(
    'ignored {"status":"progress","summary":"old"} {"status":"progress","summary":"new"}',
  );
  assert.equal(result?.summary, "new");
});

test("handles braces inside JSON strings", () => {
  assert.equal(
    jsonObjectCandidates('{"text":"}"}{"status":"blocked","summary":"stop"}').length,
    2,
  );
});

test("normalizes acceptance criteria", () => {
  assert.deepEqual(normalizeAcceptance("run tests\ncheck the diff"), ["run tests", "check the diff"]);
});

test("normal mode requires a verification turn", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-"));
  try {
    const loop = {
      id: "session",
      sessionId: "session",
      cwd,
      status: "running",
      goal: "demo",
      acceptance: [],
      maxTurns: 1,
      forceFullRun: false,
      turnCount: 1,
      turnKind: "goal",
      pauseReason: "",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "",
      rejectedClaims: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyResult(loop, { time: new Date().toISOString(), status: "completed", summary: "claimed" });
    assert.equal(loop.status, "verifying_completed");
    loop.status = "running";
    loop.turnKind = "verification";
    applyResult(loop, { time: new Date().toISOString(), status: "verified_completed", summary: "verified" });
    assert.equal(loop.status, "completed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("full-run ignores early completion and stops at the turn limit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-"));
  try {
    const loop = {
      id: "session",
      sessionId: "session",
      cwd,
      status: "running",
      goal: "demo",
      acceptance: [],
      maxTurns: 1,
      forceFullRun: true,
      turnCount: 1,
      turnKind: "goal",
      pauseReason: "",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "",
      rejectedClaims: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyResult(loop, { time: new Date().toISOString(), status: "completed", summary: "claimed" });
    assert.equal(loop.status, "paused");
    assert.equal(loop.pauseReason, "turn_limit");
    assert.equal(loop.progress[0].status, "progress");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
