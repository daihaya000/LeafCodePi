import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushNotifyTasksChangedForTests,
  notifyBotSidebarChanged,
  notifyTasksChanged,
} from "./events";

describe("events", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    flushNotifyTasksChangedForTests();
  });

  it("window が無いときはタイマーを予約しない", () => {
    vi.stubGlobal("window", undefined);
    vi.useFakeTimers();
    expect(() => {
      notifyTasksChanged();
      vi.advanceTimersByTime(1000);
    }).not.toThrow();
  });

  it("デバウンス後に tasks-changed イベントを1回だけ発火する", () => {
    vi.useFakeTimers();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    notifyTasksChanged();
    notifyTasksChanged(); // デバウンス中は予約が増えない
    vi.advanceTimersByTime(399);
    expect(dispatchEvent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0][0].type).toBe("webui:tasks-changed");
  });

  it("デバウンス発火前に window が消えても未処理例外にならない", () => {
    vi.useFakeTimers();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    notifyTasksChanged();
    // テスト環境の破棄などで発火時に window が無くなる状況を再現
    vi.stubGlobal("window", undefined);
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("bot サイドバーの変更は即時通知する", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    notifyBotSidebarChanged();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0][0].type).toBe(
      "webui:bot-sidebar-changed",
    );
    expect(dispatchEvent.mock.calls[0][0].detail.refresh).toMatch(/^\d+-\d+$/);
  });

  it("flush ヘルパーは保留中のイベントを同期的に発火する", () => {
    vi.useFakeTimers();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    notifyTasksChanged();
    flushNotifyTasksChangedForTests();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(dispatchEvent).toHaveBeenCalledTimes(1); // 二重発火しない
  });
});