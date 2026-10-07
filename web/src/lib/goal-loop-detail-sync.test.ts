import { describe, expect, it } from "vitest";
import { applyGoalLoopSummaryToDetail, goalLoopActionConflictMessage, goalLoopActionSatisfied } from "./goal-loop-detail-sync";
import type { GoalLoopDto } from "./types";

function loop(overrides: Partial<GoalLoopDto> = {}): GoalLoopDto {
  return {
    id: "loop-1",
    sessionId: "session-1",
    cwd: "C:/work",
    status: "running",
    goal: "finish tests",
    acceptance: [],
    maxTurns: 10,
    cooldownSeconds: 0,
    nextTurnAt: null,
    forceFullRun: false,
    turnCount: 3,
    turnKind: "goal",
    pauseReason: "",
    error: "",
    progress: [],
    summary: "",
    evidence: "",
    blockedReason: "",
    rejectedClaims: 0,
    unreadableStreak: 0,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyGoalLoopSummaryToDetail", () => {
  it("returns the detail unchanged when summary is missing", () => {
    const detail = loop();
    expect(applyGoalLoopSummaryToDetail(detail, undefined)).toBe(detail);
    expect(applyGoalLoopSummaryToDetail(detail, null)).toBe(detail);
  });

  it("returns undefined/null detail unchanged", () => {
    expect(applyGoalLoopSummaryToDetail(undefined, { status: "stopped", maxTurns: 10, turnCount: 3 })).toBeUndefined();
    expect(applyGoalLoopSummaryToDetail(null, { status: "stopped", maxTurns: 10, turnCount: 3 })).toBeNull();
  });

  it("merges stopped summary so the panel can leave a stale running state", () => {
    const detail = loop({ status: "running", pauseReason: "", nextTurnAt: "2026-10-05T12:00:00.000Z" });
    const next = applyGoalLoopSummaryToDetail(detail, { status: "stopped", maxTurns: 10, turnCount: 3 });
    expect(next).toMatchObject({
      status: "stopped",
      maxTurns: 10,
      turnCount: 3,
      pauseReason: "",
      error: "",
      nextTurnAt: null,
      pendingTurnRecovery: false,
      goal: "finish tests",
    });
    expect(next).not.toBe(detail);
  });

  it("returns the same object when summary fields already match", () => {
    const detail = loop({ status: "queued", turnCount: 4 });
    expect(applyGoalLoopSummaryToDetail(detail, { status: "queued", maxTurns: 10, turnCount: 4 })).toBe(detail);
  });

  it("clears a stale cooldown countdown when the summary is paused", () => {
    const detail = loop({
      status: "running",
      nextTurnAt: "2026-10-06T12:00:00.000Z",
      pendingTurnRecovery: true,
    });
    const next = applyGoalLoopSummaryToDetail(detail, { status: "paused", maxTurns: 10, turnCount: 3 });
    expect(next).toMatchObject({
      status: "paused",
      nextTurnAt: null,
      pendingTurnRecovery: false,
      goal: "finish tests",
    });
  });
});

describe("goalLoopActionSatisfied / goalLoopActionConflictMessage", () => {
  const loop = (status: GoalLoopDto["status"]) => ({ status } as GoalLoopDto);

  it("treats an already-applied outcome as success", () => {
    expect(goalLoopActionSatisfied("stop", null)).toBe(true);
    expect(goalLoopActionSatisfied("stop", loop("completed"))).toBe(true);
    expect(goalLoopActionSatisfied("pause", loop("paused"))).toBe(true);
    expect(goalLoopActionSatisfied("pause", loop("blocked"))).toBe(true);
    expect(goalLoopActionSatisfied("resume", loop("running"))).toBe(true);
    expect(goalLoopActionSatisfied("complete", loop("completed"))).toBe(true);
    expect(goalLoopActionSatisfied("pause", loop("running"))).toBe(false);
  });

  it("treats Resume that raced successful completion as satisfied", () => {
    expect(goalLoopActionSatisfied("resume", loop("completed"))).toBe(true);
    expect(goalLoopActionConflictMessage("resume", loop("completed"))).toBeNull();
    expect(goalLoopActionSatisfied("resume", loop("paused"))).toBe(false);
    expect(goalLoopActionSatisfied("resume", loop("stopped"))).toBe(false);
    expect(goalLoopActionSatisfied("resume", null)).toBe(false);
  });

  it("explains a control that lost the race to the loop ending", () => {
    expect(goalLoopActionConflictMessage("pause", loop("completed"))).toBe("Goal Loop は既に完了しています");
    expect(goalLoopActionConflictMessage("resume", loop("stopped"))).toBe("Goal Loop は既に停止しています");
    expect(goalLoopActionConflictMessage("resume", null)).toBe("Goal Loop は既に停止しています");
    expect(goalLoopActionConflictMessage("pause", loop("running"))).toBeNull();
    expect(goalLoopActionConflictMessage("stop", loop("stopped"))).toBeNull();
  });
});
