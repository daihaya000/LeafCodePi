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
  useTaskPanesNavigation: mocks.useTaskPanes,
}));
vi.mock("./GlobalAttentionProvider", () => ({
  GlobalAttentionProvider: () => <div data-testid="global-attention" />,
}));
vi.mock("@/components/task/TaskPanesHost", () => ({
  TaskPanesHost: () => <div data-testid="task-panes" />,
}));

import { AppShell, resetAppShellBootForTests } from "./AppShell";
import { resetServerSettingsHydration } from "@/lib/setting-sync";

const serverValues: Record<string, string | null> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.pathname === "/api/settings") {
    return new Response(JSON.stringify({ values: serverValues }), { status: 200 });
  }
  const body = init?.body ? (JSON.parse(String(init.body)) as { value: string | null }) : { value: null };
  return new Response(JSON.stringify({ value: body.value }), { status: 200 });
});

async function renderShell(children: ReactNode = <div />) {
  render(<AppShell>{children}</AppShell>);
  await screen.findByTestId("task-panes");
}

describe("AppShell", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    for (const key of Object.keys(serverValues)) delete serverValues[key];
  });

  beforeEach(() => {
    resetAppShellBootForTests();
    resetServerSettingsHydration();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    mocks.usePathname.mockReturnValue("/");
    mocks.useTaskPanes.mockReturnValue({ mdUp: true });
  });

  it("Composer の既定値を WebUI 起動時に初期化する", async () => {
    localStorage.setItem("leafcodepi.defaultModel", "provider::model");
    localStorage.setItem("webui:auto-optimize", "intelligence");
    localStorage.setItem("leafcodepi.defaultAgent", "reviewer");
    localStorage.setItem("webui:permission-mode", "deny");
    localStorage.setItem("webui:skill-permission", "deny");
    localStorage.setItem("webui:subagent-permission", "allow");

    await renderShell();

    expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("auto");
    expect(localStorage.getItem("webui:auto-optimize")).toBe("balanced");
    expect(localStorage.getItem("leafcodepi.defaultAgent")).toBe("default");
    expect(localStorage.getItem("webui:permission-mode")).toBe("allow");
    expect(localStorage.getItem("webui:skill-permission")).toBe("allow");
    expect(localStorage.getItem("webui:subagent-permission")).toBe("deny");
  });

  it("サーバー保存の起動時既定値をローカルキャッシュより優先する", async () => {
    localStorage.setItem(
      "leafcodepi.composerDefaults",
      JSON.stringify({ model: "local::model", autoOptimize: "cost", agent: "local" }),
    );
    localStorage.setItem("leafcodepi.composerDefaults:server-synced", "1");
    serverValues["composer-defaults"] = JSON.stringify({
      model: "server::model",
      autoOptimize: "intelligence",
      agent: "reviewer",
      thinkingLevel: "high",
    });

    await renderShell();

    expect(fetchMock).toHaveBeenCalled();
    expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("server::model");
    expect(localStorage.getItem("webui:auto-optimize")).toBe("intelligence");
    expect(localStorage.getItem("leafcodepi.defaultAgent")).toBe("reviewer");
    expect(localStorage.getItem("leafcodepi.thinkingLevel")).toBe("high");
  });

  it("サーバー未保存ならローカルの既定値を一度だけサーバーへ移行する", async () => {
    const local = JSON.stringify({ model: "local::model", autoOptimize: "cost", agent: "local" });
    localStorage.setItem("leafcodepi.composerDefaults", local);
    serverValues["composer-defaults"] = null;

    await renderShell();

    expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("local::model");
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/settings/composer-defaults"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
  });

  it("split host が有効な画面の page 内容をデスクトップではマウントしない", async () => {
    await renderShell(<div data-testid="page-content" />);

    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it.each([true, false])("Bot pages are not double-mounted (desktop=%s)", async (mdUp) => {
    mocks.useTaskPanes.mockReturnValue({ mdUp });
    mocks.usePathname.mockReturnValue("/bots/one");
    await renderShell(<div data-testid="page-content" />);
    expect(screen.queryByTestId("page-content")).toBeNull();
    expect(screen.getByTestId("task-panes")).toBeTruthy();
  });

  it("モバイルの Home では page 内容をマウントする", async () => {
    mocks.useTaskPanes.mockReturnValue({ mdUp: false });
    await renderShell(<div data-testid="page-content" />);

    const pageWrapper = screen.getByTestId("page-content").parentElement;
    expect(pageWrapper?.className.split(/\s+/)).toContain("md:hidden");
  });

  it("task 画面の page wrapper は空でも高さを奪わない", async () => {
    mocks.usePathname.mockReturnValue("/task/task-a");
    await renderShell(<div data-testid="page-content" />);

    const pageWrapper = screen.getByTestId("page-content").parentElement;
    expect(pageWrapper?.className.split(/\s+/)).toContain("hidden");
    expect(pageWrapper?.className.split(/\s+/)).not.toContain("md:hidden");
  });
});
