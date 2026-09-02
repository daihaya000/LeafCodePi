// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  beforeEach(() => {
    mocks.usePathname.mockReturnValue("/");
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

  it("モバイルの task 画面では空の page wrapper が高さを奪わない", () => {
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
