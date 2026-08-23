// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GoalLoopPanel } from "./GoalLoopPanel";
import type { GoalLoopDto } from "@/lib/types";

function loopFixture(overrides: Partial<GoalLoopDto> = {}): GoalLoopDto {
  return {
    id: "loop-1",
    sessionId: "session-1",
    cwd: "C:/work",
    status: "running",
    goal: "テストを完了する",
    acceptance: [],
    maxTurns: 10,
    cooldownSeconds: 0,
    nextTurnAt: null,
    forceFullRun: false,
    turnCount: 6,
    turnKind: "goal",
    pauseReason: "",
    error: "",
    progress: [],
    summary: "",
    evidence: "",
    blockedReason: "",
    rejectedClaims: 0,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("GoalLoopPanel progress", () => {
  afterEach(() => cleanup());

  it("shows the bounded turn progress as a percentage", () => {
    render(<GoalLoopPanel loop={loopFixture()} busy={false} onAction={() => {}} onResume={() => {}} />);

    const progress = screen.getByRole("progressbar", { name: "ループ進捗" });
    expect(progress.getAttribute("aria-valuenow")).toBe("60");
    expect(progress.getAttribute("aria-valuetext")).toBe("6/10ターン、60%");
    expect(screen.getByText("60%")).toBeTruthy();
  });

  it("labels unlimited loops without pretending to have a percentage", () => {
    render(
      <GoalLoopPanel
        loop={loopFixture({ maxTurns: 0, turnCount: 12 })}
        busy={false}
        onAction={() => {}}
        onResume={() => {}}
      />,
    );

    const progress = screen.getByRole("progressbar", { name: "ループ進捗" });
    expect(progress.getAttribute("aria-valuenow")).toBeNull();
    expect(progress.getAttribute("aria-valuetext")).toBe("12ターン実行済み（無制限）");
    expect(screen.getByText("無制限")).toBeTruthy();
  });
});
