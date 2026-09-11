// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
  push: vi.fn(),
  botStatus: "idle" as "idle" | "working",
  usePathname: vi.fn(() => "/bots"),
}));

vi.mock("@/lib/client", () => ({ getJson: mocks.getJson, sendJson: mocks.sendJson }));
vi.mock("@/lib/events", () => ({ notifyBotSidebarChanged: vi.fn(), notifyTasksChanged: vi.fn() }));
vi.mock("@/components/AddProjectButton", () => ({ AddProjectButton: () => null }));
vi.mock("@/components/codexbar/CodexBarWidget", () => ({ CodexBarWidget: () => null }));
vi.mock("@/components/sysmon/SystemMonitorWidget", () => ({ SystemMonitorWidget: () => null }));
vi.mock("@/components/shell/TaskPanesContext", () => ({
  useTaskPanes: () => ({
    activeTaskId: null,
    mdUp: true,
    splitHostEnabled: false,
    retargetToUrl: vi.fn(),
    statusFor: () => mocks.botStatus === "working" ? "working" : null,
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: mocks.usePathname,
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("@/components/ui", () => ({
  cx: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  timeAgo: () => "",
  ThemeToggle: () => null,
}));

import { Sidebar } from "./Sidebar";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("leafcodepi.mode", "bot");
  localStorage.setItem("webui.sidebar.collapsed", "1");
  mocks.getJson.mockReset().mockImplementation((path: string) => {
    if (path === "/api/bots/sidebar") {
      return Promise.resolve({
        bots: [{ id: "bot-a", name: "Bot A", enabled: true, lastMessageSummary: null, lastMessageAt: null }],
        rooms: [{ id: "room-a", name: "Room A", updatedAt: "", lastMessageSummary: null, lastMessageAt: null }],
      });
    }
    if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
    if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: [] });
    if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  });
  mocks.push.mockReset();
  mocks.botStatus = "idle";
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Bot mode list", () => {
  it("filters bots and rooms by name and by the Bot/room filter", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/sidebar") {
        return Promise.resolve({
          bots: [
            { id: "bot-a", name: "Alpha", enabled: true, lastMessageSummary: null, lastMessageAt: null },
            { id: "bot-b", name: "Beta", enabled: true, lastMessageSummary: null, lastMessageAt: null },
          ],
          rooms: [{ id: "room-a", name: "Team room", updatedAt: "", lastMessageSummary: null, lastMessageAt: null }],
        });
      }
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: [] });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    const search = await screen.findByLabelText("ボットやルームを検索");
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText("Team room")).toBeTruthy();

    // 検索は名前（大文字小文字を無視）でBotとルームを絞り込む。
    fireEvent.change(search, { target: { value: "beta" } });
    await waitFor(() => expect(screen.queryByText("Alpha")).toBeNull());
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByText("Team room")).toBeNull();

    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
    // 表示対象の絞り込みは一覧ごとに切り替わる。
    fireEvent.click(screen.getByRole("button", { name: "Bot filter" }));
    await waitFor(() => expect(screen.queryByText("Team room")).toBeNull());
    expect(screen.getByText("Alpha")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Room filter" }));
    await waitFor(() => expect(screen.queryByText("Alpha")).toBeNull());
    expect(screen.getByText("Team room")).toBeTruthy();
  });
});

describe("Bot mode collapsed rail", () => {
  it("shows a user-facing error when creating a room fails", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    vi.stubGlobal("prompt", vi.fn().mockReturnValue("失敗ルーム"));
    mocks.sendJson.mockRejectedValueOnce(new Error("ルーム作成に失敗しました"));

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "ルームを追加" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ルーム作成に失敗しました");
  });

  it("shows a user-facing error when creating a Bot fails", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    vi.stubGlobal("prompt", vi.fn().mockReturnValue("失敗Bot"));
    mocks.sendJson.mockRejectedValueOnce(new Error("Bot作成に失敗しました"));

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Botを追加" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Bot作成に失敗しました");
  });

  it("shows an error when the list refresh fails after creating a room", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    let sidebarReads = 0;
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/sidebar") {
        sidebarReads += 1;
        return sidebarReads === 1
          ? Promise.resolve({ bots: [], rooms: [] })
          : Promise.reject(new Error("一覧更新に失敗しました"));
      }
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: [] });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal("prompt", vi.fn().mockReturnValue("新規ルーム"));
    mocks.sendJson.mockResolvedValueOnce({ room: { id: "room-1" } });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await screen.findByText("ルームはありません");
    fireEvent.click(screen.getByRole("button", { name: "ルームを追加" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/bots/rooms/room-1"));

    window.dispatchEvent(new Event("webui:bot-sidebar-changed"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("一覧更新に失敗しました");
  });

  it("shows a user-facing error when Bot and Room loading fails", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/sidebar") return Promise.reject(new Error("Bot一覧の取得に失敗しました"));
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Bot一覧の取得に失敗しました");
  });

  it("animates a Bot with an in-progress Code session", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/sidebar") return Promise.resolve({ bots: [{ id: "bot-a", name: "Bot A", enabled: true, codeInProgress: true, lastMessageSummary: null, lastMessageAt: null }], rooms: [] });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    const avatar = await screen.findByRole("img", { name: "Bot Aのアバター" });
    expect(avatar.getAttribute("class") ?? "").toContain("bot-avatar-working");
  });

  it("animates a Bot while its Bot response is active", async () => {
    mocks.botStatus = "working";
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    const avatar = await screen.findByRole("img", { name: "Bot Aのアバター" });
    expect(avatar.getAttribute("class") ?? "").toContain("bot-avatar-working");
  });

  it("shows rooms and bots as icons and can expand back", async () => {
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const room = await screen.findByRole("button", { name: "Room Aを開く" });
    expect(await screen.findByRole("button", { name: "Bot Aを開く" })).toBeTruthy();
    // 折りたたみ中はプロジェクトレールを出さない。
    expect(screen.queryByRole("button", { name: /を選択/ })).toBeNull();

    fireEvent.click(room);
    expect(mocks.push).toHaveBeenCalledWith("/bots/rooms/room-a");

    fireEvent.click(screen.getByRole("button", { name: "サイドバーを展開" }));
    await waitFor(() => expect(screen.getByLabelText("ボットやルームを検索")).toBeTruthy());
    expect(localStorage.getItem("webui.sidebar.collapsed")).toBe("0");
  });
});
