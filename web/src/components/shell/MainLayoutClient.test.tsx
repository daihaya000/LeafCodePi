// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/localhost-redirect", () => ({
  maybeRedirectToLocalhost: vi.fn(),
}));

import { MainLayoutClient } from "./MainLayoutClient";

afterEach(cleanup);

describe("MainLayoutClient", () => {
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
