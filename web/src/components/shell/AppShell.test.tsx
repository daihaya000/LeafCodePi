// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  usePathname: vi.fn(() => "/"),
}));

vi.mock("next/navigation", () => ({ usePathname: mocks.usePathname }));
vi.mock("./Sidebar", () => ({ Sidebar: () => <aside data-testid="sidebar" /> }));
vi.mock("./ShellContext", () => ({
  ShellProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useShellMobileNav: () => ({ mobileNavOpen: false, closeMobileNav: vi.fn() }),
}));
vi.mock("./TaskPanesContext", () => ({
  TaskPanesProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/task/TaskPanesHost", () => ({
  TaskPanesHost: () => <div data-testid="task-panes" />,
}));

import { AppShell } from "./AppShell";

describe("AppShell", () => {
  beforeEach(() => {
    mocks.usePathname.mockReturnValue("/");
  });

  it("split host が有効な画面の page 内容をデスクトップで重ねて表示しない", () => {
    render(
      <AppShell>
        <div data-testid="page-content" />
      </AppShell>,
    );

    const pageContent = screen.getByTestId("page-content");
    const pageWrapper = pageContent.parentElement;
    expect(pageWrapper?.className.split(/\s+/)).toContain("md:hidden");
    expect(pageWrapper?.className.split(/\s+/)).not.toContain("max-md:hidden");
  });
});
