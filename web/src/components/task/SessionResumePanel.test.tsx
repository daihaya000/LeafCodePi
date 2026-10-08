// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSessionResumeRemaining, SessionResumePanel } from "./SessionResumePanel";
import type { SessionResumeDto } from "@/lib/types";

const reservation: SessionResumeDto = {
  id: "resume-1",
  at: "2026-10-08T10:32:53.000Z",
  message: "処理結果を確認する",
};

describe("SessionResumePanel", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows a scheduled time, live countdown, and the continuation note", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T10:31:53.000Z"));
    render(<SessionResumePanel reservation={reservation} />);

    expect(screen.getByRole("region", { name: "セッション再開予約" })).toBeTruthy();
    expect(screen.getByText("あと1分")).toBeTruthy();
    expect(screen.getByText(reservation.message)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText("再開待ち")).toBeTruthy();
    expect(screen.getByText("セッションがアイドルになると再開します。")).toBeTruthy();
  });

  it("hides absent reservations and formats long countdowns", () => {
    const { container } = render(<SessionResumePanel reservation={null} />);
    expect(container.firstChild).toBeNull();
    expect(formatSessionResumeRemaining(3_600_000)).toBe("あと1時間");
    expect(formatSessionResumeRemaining(3_900_000)).toBe("あと1時間5分");
  });
});
