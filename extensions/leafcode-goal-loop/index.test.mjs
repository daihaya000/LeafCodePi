import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  extractGoalResult,
  jsonObjectCandidates,
  applyResult,
  clampCooldownSeconds,
  clampMaxTurns,
  normalizeAcceptance,
  parseCooldownSeconds,
} from "./index.ts";

test("matches LeafCode turn-budget and cooldown normalization", () => {
  assert.equal(clampMaxTurns(0), 0);
  assert.equal(clampMaxTurns(101), 100);
  assert.equal(parseCooldownSeconds("15m 30s"), 930);
  assert.equal(clampCooldownSeconds(-1), 0);
});

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

test("unlimited mode does not pause at zero", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-"));
  try {
    const loop = {
      id: "session",
      sessionId: "session",
      cwd,
      status: "running",
      goal: "demo",
      acceptance: [],
      maxTurns: 0,
      cooldownSeconds: 0,
      nextTurnAt: null,
      forceFullRun: true,
      turnCount: 12,
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
    applyResult(loop, { time: new Date().toISOString(), status: "progress", summary: "still working" });
    assert.equal(loop.status, "queued");
    assert.equal(loop.pauseReason, "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("pauses after two rejected verification claims", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-"));
  try {
    const loop = {
      id: "session",
      sessionId: "session",
      cwd,
      status: "running",
      goal: "demo",
      acceptance: [],
      maxTurns: 10,
      cooldownSeconds: 0,
      nextTurnAt: null,
      forceFullRun: false,
      turnCount: 2,
      turnKind: "verification",
      pauseReason: "",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "",
      rejectedClaims: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyResult(loop, { time: new Date().toISOString(), status: "progress", summary: "not verified" });
    assert.equal(loop.status, "paused");
    assert.equal(loop.pauseReason, "verification_rejected");
    assert.equal(loop.rejectedClaims, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
