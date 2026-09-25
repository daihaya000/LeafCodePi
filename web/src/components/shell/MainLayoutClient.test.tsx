// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/shell/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="app-shell">
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

import MainLayout from "./layout";

afterEach(cleanup);

describe("MainLayout", () => {
  it("mounts AppShell (with global attention) outside conditional page content", () => {
    render(
      <MainLayout>
        <div data-testid="page-content" />
      </MainLayout>,
    );

    expect(screen.getByTestId("app-shell")).toBeTruthy();
    expect(screen.getByTestId("global-attention")).toBeTruthy();
    expect(screen.getByTestId("notification-sound")).toBeTruthy();
  });
});
