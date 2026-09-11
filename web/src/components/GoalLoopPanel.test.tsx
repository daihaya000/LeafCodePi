// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    unreadableStreak: 0,
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

  it("uses blue while running and green only after completion", () => {
    const { rerender } = render(
      <GoalLoopPanel
        loop={loopFixture({ status: "verifying_completed" })}
        busy={false}
        onAction={() => {}}
        onResume={() => {}}
      />,
    );

    const progress = screen.getByRole("progressbar", { name: "ループ進捗" });
    expect(progress.firstElementChild?.classList.contains("bg-working")).toBe(true);

    rerender(
      <GoalLoopPanel
        loop={loopFixture({ status: "completed" })}
        busy={false}
        onAction={() => {}}
        onResume={() => {}}
      />,
    );
    expect(progress.firstElementChild?.classList.contains("bg-success")).toBe(true);
  });

  it("collapses long details but keeps errors visible and allows expansion", () => {
    render(
      <GoalLoopPanel
        loop={loopFixture({ status: "blocked", error: "確認が必要です", cooldownSeconds: 30 })}
        busy={false}
        onAction={() => {}}
        onResume={() => {}}
      />,
    );

    const toggle = screen.getByRole("button", { name: "ループの詳細" });
    const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(details.hidden).toBe(true);
    expect(screen.getByText("確認が必要です").closest("[hidden]")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain("テストを完了する");
    expect(details.textContent).toContain("クールタイム: 30s");
    fireEvent.click(toggle);
    expect(details.hidden).toBe(true);
  });

  it("keeps named pause and stop controls usable when collapsed and disabled while busy", () => {
    const onAction = vi.fn();
    const props = { loop: loopFixture(), onAction, onResume: () => {} };
    const { rerender } = render(<GoalLoopPanel {...props} busy={false} />);
    const pause = screen.getByRole("button", { name: "一時停止" }) as HTMLButtonElement;
    const stop = screen.getByRole("button", { name: "停止" }) as HTMLButtonElement;
    fireEvent.click(pause);
    fireEvent.click(stop);
    expect(onAction.mock.calls).toEqual([["pause"], ["stop"]]);

    rerender(<GoalLoopPanel {...props} busy />);
    expect(pause.disabled).toBe(true);
    expect(stop.disabled).toBe(true);
    fireEvent.click(stop);
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it("allows a blocked loop to resume", () => {
    const onResume = vi.fn();
    render(
      <GoalLoopPanel
        loop={loopFixture({ status: "blocked", blockedReason: "確認が必要です" })}
        busy={false}
        onAction={() => {}}
        onResume={onResume}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "再開" }));
    expect(onResume).toHaveBeenCalledWith();
    expect(screen.getByText("要対応のため停止しました。対応後に再開できます。")).toBeTruthy();
  });

  it("offers completion at the turn limit", () => {
    const onAction = vi.fn();
    render(
      <GoalLoopPanel
        loop={loopFixture({ status: "paused", pauseReason: "turn_limit", turnCount: 10 })}
        busy={false}
        onAction={onAction}
        onResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "完了" }));
    expect(onAction).toHaveBeenCalledWith("complete");
  });

  it("does not treat an empty turn input as unlimited on resume", () => {
    const onResume = vi.fn();
    render(
      <GoalLoopPanel
        loop={loopFixture({ status: "paused", pauseReason: "turn_limit", maxTurns: 10, turnCount: 10 })}
        busy={false}
        onAction={() => {}}
        onResume={onResume}
      />,
    );

    const input = screen.getByRole("spinbutton", { name: "再開後の最大ターン数" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "再開" }));
    // 空欄は無制限(0)ではなく、現在値+1（最小の増分）で再開する。
    expect(onResume).toHaveBeenCalledWith(11);
  });

  it("offers the turn-limit input for budget-exhausted pauses beyond turn_limit", () => {
    const onResume = vi.fn();
    // unreadable_result / turn_timeout などで上限を使い切った一時停止も、
    // 上限増やしを要求されるため入力欄がないと再開できない。
    render(
      <GoalLoopPanel
        loop={loopFixture({ status: "paused", pauseReason: "unreadable_result", maxTurns: 10, turnCount: 10 })}
        busy={false}
        onAction={() => {}}
        onResume={onResume}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "再開" }));
    expect(onResume).toHaveBeenCalledWith(11);
  });

  it("resumes without a turn input while the budget is not exhausted", () => {
    const onResume = vi.fn();
    render(
      <GoalLoopPanel
        loop={loopFixture({ status: "paused", pauseReason: "user", maxTurns: 10, turnCount: 6 })}
        busy={false}
        onAction={() => {}}
        onResume={onResume}
      />,
    );

    expect(screen.queryByRole("spinbutton", { name: "再開後の最大ターン数" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "再開" }));
    expect(onResume).toHaveBeenCalledWith();
  });
});
