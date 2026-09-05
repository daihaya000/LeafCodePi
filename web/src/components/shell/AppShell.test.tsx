// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  usePathname: vi.fn(() => "/"),
  useTaskPanes: vi.fn(() => ({ mdUp: true })),
}));

vi.mock("next/navigation", () => ({ usePathname: mocks.usePathname }));
vi.mock("./Sidebar", () => ({ Sidebar: () => <aside data-testid="sidebar" /> }));
vi.mock("./ShellContext", () => ({
  ShellProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useShellMobileNav: () => ({ mobileNavOpen: false, closeMobileNav: vi.fn() }),
}));
vi.mock("./TaskPanesContext", () => ({
  TaskPanesProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useTaskPanes: mocks.useTaskPanes,
}));
vi.mock("@/components/task/TaskPanesHost", () => ({
  TaskPanesHost: () => <div data-testid="task-panes" />,
}));

import { AppShell } from "./AppShell";

describe("AppShell", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  beforeEach(() => {
    mocks.usePathname.mockReturnValue("/");
    mocks.useTaskPanes.mockReturnValue({ mdUp: true });
  });

  it("Composer の既定値を WebUI 起動時に初期化する", () => {
    localStorage.setItem("leafcodepi.defaultModel", "provider::model");
    localStorage.setItem("webui:auto-optimize", "intelligence");
    localStorage.setItem("leafcodepi.defaultAgent", "reviewer");
    localStorage.setItem("webui:permission-mode", "deny");
    localStorage.setItem("webui:skill-permission", "deny");
    localStorage.setItem("webui:subagent-permission", "allow");

    render(<AppShell><div /></AppShell>);

    expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("auto");
    expect(localStorage.getItem("webui:auto-optimize")).toBe("balanced");
    expect(localStorage.getItem("leafcodepi.defaultAgent")).toBe("__auto__");
    expect(localStorage.getItem("webui:permission-mode")).toBe("allow");
    expect(localStorage.getItem("webui:skill-permission")).toBe("allow");
    expect(localStorage.getItem("webui:subagent-permission")).toBe("deny");
  });

  it("split host が有効な画面の page 内容をデスクトップではマウントしない", () => {
    render(
      <AppShell>
        <div data-testid="page-content" />
      </AppShell>,
    );

    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it("モバイルの Home では page 内容をマウントする", () => {
    mocks.useTaskPanes.mockReturnValue({ mdUp: false });
    render(
      <AppShell>
        <div data-testid="page-content" />
      </AppShell>,
    );

    const pageWrapper = screen.getByTestId("page-content").parentElement;
    expect(pageWrapper?.className.split(/\s+/)).toContain("md:hidden");
  });

  it("task 画面の page wrapper は空でも高さを奪わない", () => {
    mocks.usePathname.mockReturnValue("/task/task-a");
    render(
      <AppShell>
        <div data-testid="page-content" />
      </AppShell>,
    );

    const pageWrapper = screen.getByTestId("page-content").parentElement;
    expect(pageWrapper?.className.split(/\s+/)).toContain("hidden");
    expect(pageWrapper?.className.split(/\s+/)).not.toContain("md:hidden");
  });
});
