// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
  push: vi.fn(),
  botStatus: "idle" as "idle" | "working",
  paneMdUp: true,
  dispatch: vi.fn(),
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
    dispatch: mocks.dispatch,
    mdUp: true,
    splitHostEnabled: false,
    retargetToUrl: vi.fn(),
    statusFor: () => mocks.botStatus === "working" ? "working" : null,
  }),
  useBotStatusFor: () => () => mocks.botStatus === "working" ? "working" : null,
  useTaskPanesNavigation: () => ({
    activeTaskId: null,
    dispatch: mocks.dispatch,
    mdUp: mocks.paneMdUp,
    splitHostEnabled: false,
    retargetToUrl: vi.fn(),
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
  Button: ({ children, busy, ...props }: { children: ReactNode; busy?: boolean; [key: string]: unknown }) => {
    void busy;
    return <button {...props}>{children}</button>;
  },
  cx: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  timeAgo: () => "",
  ThemeToggle: () => null,
}));

import { markRead } from "@/lib/bot-unread";
import { Sidebar } from "./Sidebar";

beforeEach(() => {
  document.title = "LCP X870";
  localStorage.clear();
  localStorage.setItem("leafcodepi.mode", "bot");
  localStorage.setItem("webui.sidebar.collapsed", "1");
  mocks.getJson.mockReset().mockImplementation((path: string) => {
    if (path === "/api/bots/sidebar") {
      return Promise.resolve({
        bots: [{ id: "bot-a", name: "Bot A", label: "デバッガー", enabled: true, lastMessageSummary: null, lastMessageAt: null }],
        rooms: [{ id: "room-a", name: "Room A", updatedAt: "", lastMessageSummary: null, lastMessageAt: null }],
      });
    }
    if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
    if (path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
    if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  });
  mocks.sendJson.mockReset().mockResolvedValue({});
  mocks.push.mockReset();
  mocks.dispatch.mockReset();
  mocks.botStatus = "idle";
  mocks.paneMdUp = true;
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
  it("switches to Code without navigating to the Code home", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    mocks.usePathname.mockReturnValue("/");
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Code" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Code" }).getAttribute("aria-pressed")).toBe("true"));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(localStorage.getItem("leafcodepi.mode")).toBe("code");
  });

  it("switches to Code while a Bot tab is open", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    mocks.usePathname.mockReturnValue("/bots/bot-a");
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Bot" }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Code" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Code" }).getAttribute("aria-pressed")).toBe("true"));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(localStorage.getItem("leafcodepi.mode")).toBe("code");
  });

  it("keeps the Code label and shows an unread dot", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/sidebar") return Promise.resolve({ bots: [], rooms: [] });
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?kind=all") return Promise.resolve({ tasks: [{ id: "code-a", kind: "code", status: "idle", updatedAt: "2026-09-22T00:00:00.000Z" }] });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const code = await screen.findByRole("button", { name: "Code（未読）" });
    expect(code.textContent).toContain("Code");
    expect(code.querySelector(".bg-accent")).toBeTruthy();
  });

  it("shows the total unread Code, Bot, and Room count in the browser tab", async () => {
    const updatedAt = "2026-09-22T00:00:00.000Z";
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/sidebar") return Promise.resolve({
        bots: [{ id: "title-bot", name: "Bot", lastMessageAt: updatedAt }],
        rooms: [{ id: "title-room", name: "Room", lastMessageAt: updatedAt }],
      });
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?kind=all") return Promise.resolve({ tasks: [
        { id: "title-code", kind: "code", status: "idle", updatedAt },
        { id: "title-working", kind: "code", status: "working", updatedAt },
      ] });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    await waitFor(() => expect(document.title).toBe("(3) LCP X870"));
    act(() => markRead("task", "title-code", Date.parse(updatedAt)));
    await waitFor(() => expect(document.title).toBe("(2) LCP X870"));
    act(() => {
      markRead("bot", "title-bot", Date.parse(updatedAt));
      markRead("room", "title-room", Date.parse(updatedAt));
    });
    await waitFor(() => expect(document.title).toBe("LCP X870"));
  });

  it("navigates to the Bot home when panes are unavailable", async () => {
    localStorage.setItem("leafcodepi.mode", "code");
    localStorage.setItem("webui.sidebar.collapsed", "0");
    mocks.paneMdUp = false;
    mocks.usePathname.mockReturnValue("/");
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Code" }).getAttribute("aria-pressed")).toBe("true");
    });
    fireEvent.click(screen.getByRole("button", { name: "Bot" }));

    expect(mocks.push).toHaveBeenCalledWith("/bots");
  });

  it("polls unread updates while the document is hidden", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    try {
      render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
      await screen.findByText("Bot A");
      mocks.getJson.mockClear();
      const pollCallbacks = setIntervalSpy.mock.calls
        .filter(([, delay]) => delay === 12_000)
        .map(([callback]) => callback as () => void);
      expect(pollCallbacks.length).toBeGreaterThan(0);
      pollCallbacks.forEach((callback) => callback());
      expect(mocks.getJson.mock.calls.filter(([path]) => path === "/api/bots/sidebar")).toHaveLength(1);
      expect(mocks.getJson.mock.calls.filter(([path]) => path === "/api/tasks?kind=all")).toHaveLength(1);
    } finally {
      setIntervalSpy.mockRestore();
      visibility.mockRestore();
    }
  });

  it("shares health and keeps the initial Bot read coalescible", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    await screen.findByText("Bot A");
    expect(mocks.getJson.mock.calls.filter(([path]) => path === "/api/health")).toHaveLength(1);
    expect(mocks.getJson.mock.calls.filter(([path]) => path === "/api/bots")).toHaveLength(0);
    const botRead = mocks.getJson.mock.calls.find(([path]) => path === "/api/bots/sidebar");
    expect(botRead?.[1]).toBeUndefined();
  });

  it("shows a Bot label beside its name", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const label = await screen.findByText("デバッガー");
    expect(label.getAttribute("title")).toBe("デバッガー");
    expect(label.className).toContain("rounded-md");
  });

  it("uses all working Code and Bot tasks for the split button", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/sidebar") return Promise.resolve({ bots: [{ id: "bot-a", name: "Alpha" }], rooms: [] });
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      // アーカイブ済みタスクは展開時のみ取得するため、通常表示は kind=all が作業中タスクを運ぶ。
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") {
        return Promise.resolve({
          tasks: [
            { id: "bot:bot-a", kind: "bot", status: "working", updatedAt: "2026-01-01T00:02:00.000Z" },
            { id: "code-a", kind: "code", status: "working", updatedAt: "2026-01-01T00:01:00.000Z" },
          ],
        });
      }
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks?kind=all"));
    fireEvent.click(await screen.findByRole("button", { name: "進行中タスクを分割表示" }));
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith({
      type: "showWorkingTasks",
      taskIds: ["/bots/bot-a", "code-a"],
    }));
  });

  it("maps a Bot-owned Code session onto the BotView tab when splitting", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/sidebar") return Promise.resolve({ bots: [{ id: "bot-a", name: "Alpha" }], rooms: [] });
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") {
        return Promise.resolve({
          tasks: [
            { id: "code-linked", kind: "code", botId: "bot-a", status: "working", updatedAt: "2026-01-01T00:03:00.000Z" },
            { id: "bot:bot-a", kind: "bot", botId: "bot-a", status: "working", updatedAt: "2026-01-01T00:02:00.000Z" },
          ],
        });
      }
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks?kind=all"));
    fireEvent.click(await screen.findByRole("button", { name: "進行中タスクを分割表示" }));
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith({
      type: "showWorkingTasks",
      taskIds: ["/bots/bot-a"],
    }));
  });

  it("includes a Bot-owned Code request before its task is persisted", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/sidebar") return Promise.resolve({ bots: [{ id: "bot-a", name: "Alpha", codeInProgress: true }], rooms: [] });
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await screen.findByRole("img", { name: "Alphaのアバター" });
    fireEvent.click(screen.getByRole("button", { name: "進行中タスクを分割表示" }));
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith({
      type: "showWorkingTasks",
      taskIds: ["/bots/bot-a"],
    }));
  });

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
      if (path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
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
      if (path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
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

  it("shows the Bot progress count when a Code session is active", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/bots/sidebar") return Promise.resolve({ bots: [{ id: "bot-a", name: "Bot A", enabled: true, codeInProgress: true, lastMessageSummary: null, lastMessageAt: null }], rooms: [] });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    const avatar = await screen.findByRole("img", { name: "Bot Aのアバター" });
    expect(avatar.getAttribute("class") ?? "").toContain("bot-avatar-working");
    expect(await screen.findByRole("button", { name: "Bot（進行中1件）" })).toBeTruthy();
  });

  it("shows the Bot progress count while its Bot response is active", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    mocks.botStatus = "working";
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    const avatar = await screen.findByRole("img", { name: "Bot Aのアバター" });
    expect(avatar.getAttribute("class") ?? "").toContain("bot-avatar-working");
    expect(await screen.findByRole("button", { name: "Bot（進行中1件）" })).toBeTruthy();
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

describe("モバイルナビゲーション", () => {
  it("TaskView のペイン操作より前面で操作を受ける", async () => {
    mocks.paneMdUp = false;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const onClose = vi.fn();

    render(<Sidebar mobileOpen onClose={onClose} />);

    const backdrop = (await screen.findAllByRole("button", { name: "メニューを閉じる" }))
      .find((button) => button.className.includes("fixed"));
    expect(backdrop).toBeTruthy();
    // TaskPanesHost のリサイズハンドル（z-80）より上に置く。
    expect(backdrop?.className).toContain("z-[90]");
    expect(screen.getByRole("dialog", { name: "ナビゲーション" }).className).toContain("z-[100]");

    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("サイドバー幅のドラッグ", () => {
  it("ドラッグ中は端がカーソルに追従し、最小幅を下回るとレール表示、離すと吸着する", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "0");
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const handle = await screen.findByRole("separator", { name: "サイドバーの幅を調整" });
    const aside = handle.parentElement as HTMLElement;
    expect(aside.style.width).toBe("240px");

    fireEvent.pointerDown(handle, { clientX: 240 });
    fireEvent.pointerMove(window, { clientX: 170 });
    await waitFor(() => expect(aside.style.width).toBe("170px"));
    expect(localStorage.getItem("webui.sidebar.collapsed")).toBe("1");
    // 最小表示中は通常表示用の幅を書き換えない（戻したときに復元するため）。
    expect(localStorage.getItem("webui.sidebar.width")).toBeNull();
    // レール幅より狭くはしない。
    fireEvent.pointerMove(window, { clientX: 60 });
    await waitFor(() => expect(aside.style.width).toBe("80px"));
    fireEvent.pointerUp(window);
    await waitFor(() => expect(aside.style.width).toBe("80px"));

    // 最小表示からのドラッグは、右へ引いた分だけ即座に広がる（デッドゾーンなし）。
    fireEvent.pointerDown(handle, { clientX: 80 });
    fireEvent.pointerMove(window, { clientX: 130 });
    await waitFor(() => expect(aside.style.width).toBe("130px"));
    expect(screen.queryByRole("button", { name: "サイドバーを展開" })).toBeTruthy();
    fireEvent.pointerMove(window, { clientX: 180 });
    await waitFor(() => expect(aside.style.width).toBe("180px"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "サイドバーを展開" })).toBeNull());
    fireEvent.pointerUp(window);
    expect(aside.style.width).toBe("180px");
    expect(localStorage.getItem("webui.sidebar.width")).toBe("180");
    expect(localStorage.getItem("webui.sidebar.collapsed")).toBe("0");
  });
});
