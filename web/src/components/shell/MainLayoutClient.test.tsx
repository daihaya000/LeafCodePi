// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/shell/AppShell", () => ({
  AppShell: ({ children, initialSettings }: { children: ReactNode; initialSettings?: Record<string, string | null> }) => (
    <div data-testid="app-shell" data-settings={JSON.stringify(initialSettings ?? null)}>
      {children}
      <div data-testid="global-attention" />
    </div>
  ),
}));
vi.mock("@/components/NotificationSoundSync", () => ({
  NotificationSoundSync: () => <div data-testid="notification-sound" />,
}));
vi.mock("@/components/BotRoutineNotifier", () => ({
  BotRoutineNotifier: () => null,
}));
vi.mock("@/lib/localhost-redirect", () => ({
  maybeRedirectToLocalhost: vi.fn(),
}));

import { MainLayoutClient } from "./MainLayoutClient";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MainLayoutClient", () => {
  it("shows and counts down the estimate for a tray-host restart", async () => {
    vi.useFakeTimers();
    const view = render(
      <MainLayoutClient>
        <div />
      </MainLayoutClient>,
    );
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("leafcode:webui-restart", { detail: { target: "host" } }),
        );
      });
      expect(screen.getByText("推定残り時間: 5:00")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByText("推定残り時間: 4:59")).toBeTruthy();
      act(() => {
        window.dispatchEvent(
          new CustomEvent("leafcode:webui-restart", { detail: { target: "webui" } }),
        );
      });
      expect(screen.queryByText(/推定残り時間/)).toBeNull();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("counts down the host measurement and keeps waiting after it is exceeded", async () => {
    vi.useFakeTimers();
    const view = render(<MainLayoutClient><div /></MainLayoutClient>);
    try {
      act(() => {
        window.dispatchEvent(new CustomEvent("leafcode:webui-restart", {
          detail: { target: "host", estimateMs: 99_000 },
        }));
      });
      expect(screen.getByText("推定残り時間: 1:39")).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(screen.getByText("推定残り時間: 1:38")).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(99_000); });
      expect(screen.getByText("推定時間を超過。再接続を待っています。")).toBeTruthy();
      expect(screen.getByRole("status")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("mounts AppShell (with global attention) outside conditional page content", () => {
    render(
      <MainLayoutClient initialSettings={{ "composer-defaults": "{}" }}>
        <div data-testid="page-content" />
      </MainLayoutClient>,
    );

    expect(screen.getByTestId("app-shell")).toBeTruthy();
    expect(screen.getByTestId("global-attention")).toBeTruthy();
    expect(screen.getByTestId("notification-sound")).toBeTruthy();
    // サーバ描画で埋め込んだ設定を AppShell へ渡す。
    expect(screen.getByTestId("app-shell").dataset.settings).toBe(JSON.stringify({ "composer-defaults": "{}" }));
  });
});
