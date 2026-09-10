// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/shell/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));
vi.mock("@/components/NotificationSoundSync", () => ({
  NotificationSoundSync: () => <div data-testid="notification-sound" />,
}));
vi.mock("@/components/shell/GlobalAttentionProvider", () => ({
  GlobalAttentionProvider: () => <div data-testid="global-attention" />,
}));
vi.mock("@/lib/localhost-redirect", () => ({
  maybeRedirectToLocalhost: vi.fn(),
}));

import MainLayout from "./layout";

afterEach(cleanup);

describe("MainLayout", () => {
  it("mounts global attention outside conditional page content", () => {
    render(
      <MainLayout>
        <div data-testid="page-content" />
      </MainLayout>,
    );

    expect(screen.getByTestId("global-attention")).toBeTruthy();
    expect(screen.getByTestId("notification-sound")).toBeTruthy();
  });
});
