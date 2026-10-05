// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCooldownRemaining, GoalLoopPanel } from "./GoalLoopPanel";
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

  it("uses compact upper controls on wide loop containers", () => {
    render(<GoalLoopPanel loop={loopFixture()} busy={false} onAction={() => {}} onResume={() => {}} />);

    expect(screen.getByRole("button", { name: "ループの詳細" }).className).toContain("@lg/goal:min-h-6");
    expect(screen.getByRole("button", { name: "一時停止" }).className).toContain("@lg/goal:!h-6");
    expect(screen.getByRole("button", { name: "停止" }).className).toContain("@lg/goal:!h-6");
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

  it("shows configured acceptance criteria in the expanded details", () => {
    render(
      <GoalLoopPanel
        loop={loopFixture({ acceptance: ["テストが通ること", "検証結果を確認する"] })}
        busy={false}
        onAction={() => {}}
        onResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "ループの詳細" }));
    expect(screen.getByText("承認条件")).toBeTruthy();
    expect(screen.getByText("テストが通ること")).toBeTruthy();
    expect(screen.getByText("検証結果を確認する")).toBeTruthy();
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

  it("allows a blocked loop to resume or complete", () => {
    const onResume = vi.fn();
    const onAction = vi.fn();
    render(
      <GoalLoopPanel
        loop={loopFixture({ status: "blocked", blockedReason: "確認が必要です" })}
        busy={false}
        onAction={onAction}
        onResume={onResume}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "再開" }));
    expect(onResume).toHaveBeenCalledWith();
    fireEvent.click(screen.getByRole("button", { name: "完了" }));
    expect(onAction).toHaveBeenCalledWith("complete");
    expect(screen.getByText("要対応のため停止しました。対応後に再開するか、ここで完了できます。")).toBeTruthy();
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

  it("identifies a lifecycle pause and asks the operator to resume after reconnect", () => {
    render(
      <GoalLoopPanel
        loop={loopFixture({ status: "paused", pauseReason: "session_end", maxTurns: 10, turnCount: 6 })}
        busy={false}
        onAction={() => {}}
        onResume={() => {}}
      />,
    );

    expect(screen.getByText("セッション終了時に一時停止しました。再接続後に再開してください。")).toBeTruthy();
  });

  it("shows the same turn and resumes without a turn input after an interrupted turn", () => {
    const onResume = vi.fn();
    render(
      <GoalLoopPanel
        loop={loopFixture({
          status: "paused",
          pauseReason: "turn_timeout",
          maxTurns: 10,
          turnCount: 10,
          retryInterruptedTurn: true,
        })}
        busy={false}
        onAction={() => {}}
        onResume={onResume}
      />,
    );

    // 中断ターンの再送は次に消費する番号ではなく、同じ番号を使い回す。
    expect(screen.getByLabelText(/ループ 10 \/ 10/)).toBeTruthy();
    expect(screen.getByText("中断したターン（10）を再送します。ターン枠は消費しません。")).toBeTruthy();
    expect(screen.queryByRole("spinbutton", { name: "再開後の最大ターン数" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "再開" }));
    expect(onResume).toHaveBeenCalledWith();
  });

  it("shows a hang pause hint", () => {
    render(
      <GoalLoopPanel
        loop={loopFixture({ status: "paused", pauseReason: "hang", error: "hung" })}
        busy={false}
        onAction={() => {}}
        onResume={() => {}}
      />,
    );
    expect(screen.getByText(/ハング検知で一時停止しました/)).toBeTruthy();
  });

  it("counts the cooldown down and clears it when nextTurnAt expires", () => {
    vi.useFakeTimers();
    try {
      const nextTurnAt = new Date(Date.now() + 3_000).toISOString();
      render(
        <GoalLoopPanel
          loop={loopFixture({ status: "queued", nextTurnAt, cooldownSeconds: 3, turnCount: 1 })}
          busy={false}
          onAction={() => {}}
          onResume={() => {}}
        />,
      );
      expect(screen.getByText(/次のターンまで 3秒/)).toBeTruthy();
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(screen.getByText(/次のターンまで 2秒/)).toBeTruthy();
      act(() => { vi.advanceTimersByTime(2_100); });
      expect(screen.queryByText(/次のターンまで/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats long cooldowns as m:ss", () => {
    expect(formatCooldownRemaining(125_000)).toBe("2:05");
    expect(formatCooldownRemaining(400)).toBe("1秒");
  });
});
