// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
  push: vi.fn(),
  usePathname: vi.fn(() => "/"),
  retargetToUrl: vi.fn(),
  dispatch: vi.fn(),
  activeTaskId: null as string | null,
}));

vi.mock("@/lib/client", () => ({
  getJson: mocks.getJson,
  sendJson: mocks.sendJson,
}));
vi.mock("@/lib/events", () => ({ notifyBotSidebarChanged: vi.fn(), notifyTasksChanged: vi.fn() }));
vi.mock("@/components/AddProjectButton", () => ({
  AddProjectButton: () => <button type="button">プロジェクトを追加</button>,
}));
vi.mock("@/components/codexbar/CodexBarWidget", () => ({ CodexBarWidget: () => null }));
vi.mock("@/components/sysmon/SystemMonitorWidget", () => ({ SystemMonitorWidget: () => null }));
vi.mock("@/components/shell/TaskPanesContext", () => ({
  useTaskPanes: () => ({
    activeTaskId: mocks.activeTaskId,
    mdUp: true,
    splitHostEnabled: false,
    retargetToUrl: mocks.retargetToUrl,
    dispatch: mocks.dispatch,
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

const projects = [
  { id: "project-a", name: "Project A", rootPath: "C:\\repo-a", favorite: false, archived: false, createdAt: "", lastOpenedAt: null },
  { id: "project-b", name: "Project B", rootPath: "C:\\repo-b", favorite: false, archived: false, createdAt: "", lastOpenedAt: null },
  { id: "project-c", name: "Project C", rootPath: "C:\\repo-c", favorite: false, archived: false, createdAt: "", lastOpenedAt: null },
];

function createDataTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "",
    dropEffect: "",
    types: ["application/x-leafcode-project", "text/plain"],
    setData(type: string, value: string) {
      data.set(type, value);
    },
    getData(type: string) {
      return data.get(type) ?? "";
    },
  };
}

function projectOrder() {
  return [...document.querySelectorAll<HTMLElement>("[data-project-row]")].map(
    (row) => row.dataset.projectRow,
  );
}

beforeEach(() => {
  localStorage.clear();
  // These tests exercise the Code sidebar; opt into it explicitly now that Bot is the default.
  localStorage.setItem("leafcodepi.mode", "code");
  mocks.getJson.mockReset().mockImplementation((path: string) => {
    if (path === "/api/projects?archived=1") return Promise.resolve({ projects });
    if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: [] });
    if (path === "/api/health") {
      return Promise.resolve({
        ok: true,
        engine: "pi",
        engineOk: true,
        version: "1.0.0",
        modelCount: 0,
        dataDir: "C:\\data",
        error: null,
      });
    }
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  });
  mocks.sendJson.mockReset().mockResolvedValue({});
  mocks.push.mockReset();
  mocks.usePathname.mockReset().mockReturnValue("/");
  mocks.retargetToUrl.mockReset();
  mocks.dispatch.mockReset();
  mocks.activeTaskId = null;
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

describe("Sidebar project ordering", () => {
  it("defaults to Bot mode when no mode is saved", () => {
    localStorage.removeItem("leafcodepi.mode");
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const modeSegment = screen.getByRole("button", { name: "Code" }).parentElement!;
    const modeButtons = [...modeSegment.querySelectorAll("button")];
    expect(modeButtons.map((button) => button.textContent)).toEqual(["Bot", "Code"]);
    expect(modeButtons[0]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("進行中タスクをワンクリックで分割表示する", async () => {
    const workingTasks = [
      {
        id: "working-old",
        projectId: "project-a",
        projectName: "Project A",
        title: "Old working task",
        directory: "C:\\repo-a",
        isolation: "current_folder" as const,
        status: "working" as const,
        sessionId: "working-old",
        sessionFile: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        error: null,
      },
      {
        id: "working-new",
        projectId: "project-b",
        projectName: "Project B",
        title: "New working task",
        directory: "C:\\repo-b",
        isolation: "current_folder" as const,
        status: "working" as const,
        sessionId: "working-new",
        sessionFile: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
        error: null,
      },
    ];
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects });
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: workingTasks });
      if (path === "/api/health") {
        return Promise.resolve({
          ok: true,
          engine: "pi",
          engineOk: true,
          version: "1.0.0",
          modelCount: 0,
          dataDir: "C:\\data",
          error: null,
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "進行中タスクを分割表示" }));
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: "showWorkingTasks",
      taskIds: ["working-new", "working-old"],
    });
  });

  it("filters Code projects and sessions from the search field", async () => {
    const projectTasks = [
      {
        id: "session-a",
        projectId: "project-a",
        projectName: "Project A",
        title: "Alpha session",
        directory: "C:\\repo-a",
        isolation: "current_folder" as const,
        status: "ready" as const,
        sessionId: "session-a",
        sessionFile: null,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "session-b",
        projectId: "project-b",
        projectName: "Project B",
        title: "Beta session",
        directory: "C:\\repo-b",
        isolation: "current_folder" as const,
        status: "ready" as const,
        sessionId: "session-b",
        sessionFile: null,
        createdAt: "",
        updatedAt: "",
      },
    ];
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects });
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: projectTasks });
      if (path === "/api/health") {
        return Promise.resolve({
          ok: true,
          engine: "pi",
          engineOk: true,
          version: "1.0.0",
          modelCount: 0,
          dataDir: "C:\\data",
          error: null,
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const search = await screen.findByRole("textbox", { name: "プロジェクトやセッションを検索" });
    fireEvent.change(search, { target: { value: "beta session" } });

    await waitFor(() => {
      expect(screen.queryByText("Project A")).toBeNull();
      expect(screen.getByRole("button", { name: "Project Bを展開" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Project Bを展開" }));
    expect(screen.getByText("Beta session")).toBeTruthy();
    expect(screen.queryByText("Alpha session")).toBeNull();

    fireEvent.change(search, { target: { value: "project a" } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Project Aを展開" })).toBeTruthy();
      expect(screen.queryByText("Project B")).toBeNull();
    });
  });

  it("shows a user-facing error when a project icon cannot be read", async () => {
    const reader = {
      result: null,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      readAsDataURL: vi.fn(),
    };
    vi.stubGlobal("FileReader", vi.fn(() => reader));
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const input = (await screen.findByLabelText("Project Aのアイコンを設定")) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["icon"], "icon.png", { type: "image/png" })] },
    });
    reader.onerror?.();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("プロジェクトアイコンの読み込みに失敗しました");
  });

  it("uses the displayed project icon as the file picker", async () => {
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const input = (await screen.findByLabelText("Project Aのアイコンを設定")) as HTMLInputElement;
    const picker = input.parentElement;
    expect(picker?.tagName).toBe("LABEL");
    expect(picker?.title).toBe("Project Aのアイコンを設定");

    fireEvent.change(input!, {
      target: { files: [new File(["icon"], "icon.png", { type: "image/png" })] },
    });

    await waitFor(() => {
      expect(mocks.sendJson).toHaveBeenCalledWith(
        "/api/projects",
        {
          id: "project-a",
          icon: expect.stringMatching(/^data:image\/png;base64,/),
        },
        "PATCH",
      );
    });
  });

  it("reorders projects with native DnD and persists the order", async () => {
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    const source = await screen.findByRole("button", { name: "Project Aを展開" });
    const target = await screen.findByRole("button", { name: "Project Cを展開" });
    const targetRow = target.parentElement as HTMLElement;
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 40,
      height: 40,
      left: 0,
      right: 240,
      width: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer, clientY: 10 });

    await waitFor(() => {
      expect(projectOrder()).toEqual(["project-b", "project-a", "project-c"]);
      expect(localStorage.getItem("webui.sidebar.project_order")).toBe(
        JSON.stringify(["project-b", "project-a", "project-c"]),
      );
    });
  });

  it("supports keyboard reordering as the accessible DnD alternative", async () => {
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    const source = await screen.findByRole("button", { name: "Project Bを展開" });

    fireEvent.keyDown(source, { key: " " });
    fireEvent.keyDown(source, { key: "ArrowUp" });
    fireEvent.keyDown(source, { key: " " });

    await waitFor(() => {
      expect(projectOrder()).toEqual(["project-b", "project-a", "project-c"]);
      expect(localStorage.getItem("webui.sidebar.project_order")).toBe(
        JSON.stringify(["project-b", "project-a", "project-c"]),
      );
    });
  });

  it("makes project task lists scrollable at five tasks", async () => {
    const projectTasks = Array.from({ length: 5 }, (_, index) => ({
      id: `task-${index}`,
      projectId: "project-a",
      projectName: "Project A",
      title: `Task ${index + 1}`,
      directory: "C:\\repo-a",
      isolation: "current_folder" as const,
      status: "ready" as const,
      sessionId: null,
      sessionFile: null,
      createdAt: "",
      updatedAt: "",
    }));
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects });
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: projectTasks });
      if (path === "/api/health") {
        return Promise.resolve({
          ok: true,
          engine: "pi",
          engineOk: true,
          version: "1.0.0",
          modelCount: 0,
          dataDir: "C:\\data",
          error: null,
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Project Aを展開" }));

    const taskList = screen.getByText("Task 1").closest("ul");
    expect(taskList?.className).toContain("max-h-72");
    expect(taskList?.className).toContain("overflow-y-auto");
  });

  it("lets the project task toggle collapse the active project", async () => {
    const projectTasks = [{
      id: "task-1",
      projectId: "project-a",
      projectName: "Project A",
      title: "Active task",
      directory: "C:\\repo-a",
      isolation: "current_folder" as const,
      status: "ready" as const,
      sessionId: null,
      sessionFile: null,
      createdAt: "",
      updatedAt: "",
    }];
    mocks.activeTaskId = "task-1";
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects });
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: projectTasks });
      if (path === "/api/health") {
        return Promise.resolve({
          ok: true,
          engine: "pi",
          engineOk: true,
          version: "1.0.0",
          modelCount: 0,
          dataDir: "C:\\data",
          error: null,
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const toggle = await screen.findByRole("button", { name: "Project Aを折りたたむ" });
    expect(screen.getByText("Active task")).toBeTruthy();
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Project Aを展開" })).toBeTruthy();
      expect(screen.queryByText("Active task")).toBeNull();
    });
  });

  it("marks the active project in the collapsed Code rail", async () => {
    const projectTasks = [{
      id: "task-1",
      projectId: "project-a",
      projectName: "Project A",
      title: "Active task",
      directory: "C:\\repo-a",
      isolation: "current_folder" as const,
      status: "ready" as const,
      sessionId: null,
      sessionFile: null,
      createdAt: "",
      updatedAt: "",
    }];
    localStorage.setItem("webui.sidebar.collapsed", "1");
    mocks.activeTaskId = "task-1";
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects });
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: projectTasks });
      if (path === "/api/health") {
        return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const activeProject = await screen.findByRole("button", { name: "Project Aのタスクを表示" });
    expect(activeProject.getAttribute("aria-current")).toBe("page");
    expect(activeProject.className).toContain("bg-surface-2");
  });

  it("shows a user-facing error when sidebar data loading fails", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.reject(new Error("プロジェクト取得に失敗しました"));
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: [] });
      if (path === "/api/health") {
        return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("プロジェクト取得に失敗しました");
  });

  it("shows a user-facing error when a project action fails", async () => {
    mocks.sendJson.mockRejectedValueOnce(new Error("アーカイブに失敗しました"));
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Project Aをアーカイブ" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("アーカイブに失敗しました");
  });

  it("opens HomeView from the header button to the left of project add", async () => {
    const onClose = vi.fn();
    render(<Sidebar mobileOpen={false} onClose={onClose} />);

    const newTaskButton = await screen.findByRole("button", { name: "新規タスクを作成" });
    const addProjectButton = screen.getByRole("button", { name: "プロジェクトを追加" });
    expect(addProjectButton.previousElementSibling).toBe(newTaskButton);

    fireEvent.click(newTaskButton);

    expect(mocks.retargetToUrl).toHaveBeenCalledWith("home");
    expect(mocks.push).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses Bot terminology and creates from the header buttons", async () => {
    mocks.usePathname.mockReturnValue("/bots");
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: [] });
      if (path === "/api/health") {
        return Promise.resolve({
          ok: true,
          engine: "pi",
          engineOk: true,
          version: "1.0.0",
          modelCount: 0,
          dataDir: "C:\\data",
          error: null,
        });
      }
      if (path === "/api/bots") return Promise.resolve({ bots: [] });
      if (path === "/api/bots/rooms") return Promise.resolve({ rooms: [] });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    expect(await screen.findByRole("link", { name: /LeafCodePi/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Botを追加" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ルームを追加" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "プロジェクトを追加" })).toBeNull();
    expect(screen.getByRole("button", { name: "Bot" })).toBeTruthy();
    expect(screen.getByText("ルームはありません")).toBeTruthy();
    expect(screen.getByText("Botはありません")).toBeTruthy();

    expect(screen.queryByPlaceholderText("新しいBot")).toBeNull();
    expect(screen.queryByPlaceholderText("新しいルーム")).toBeNull();

    vi.stubGlobal("prompt", vi.fn().mockReturnValue("新規"));
    mocks.sendJson.mockResolvedValueOnce({ room: { id: "room-1" } });
    fireEvent.click(screen.getByRole("button", { name: "ルームを追加" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/bots/rooms/room-1"));
    expect(mocks.sendJson).toHaveBeenCalledWith("/api/bots/rooms", { name: "新規" });
  });

  it("refreshes bot entries after navigation and hides the profile label", async () => {
    const initialBot = {
      id: "bot-1",
      name: "Test",
      label: "1:1 アシスタント",
      avatarColor: "#0071E3",
      avatarImage: null,
      enabled: true,
      lastMessageSummary: null,
      lastMessageAt: null,
    };
    const nextBot = { ...initialBot, id: "bot-2", name: "New bot" };
    let currentBots = [initialBot];
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: [] });
      if (path === "/api/health") {
        return Promise.resolve({
          ok: true,
          engine: "pi",
          engineOk: true,
          version: "1.0.0",
          modelCount: 0,
          dataDir: "C:\\data",
          error: null,
        });
      }
      if (path === "/api/bots/sidebar") return Promise.resolve({ bots: currentBots, rooms: [] });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    mocks.usePathname.mockReturnValue("/bots/bot-1");

    const view = render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    expect(await screen.findByText("Test")).toBeTruthy();
    expect(screen.queryByText("1:1 アシスタント")).toBeNull();

    currentBots = [nextBot];
    mocks.usePathname.mockReturnValue("/bots/bot-2");
    view.rerender(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("New bot")).toBeTruthy();
      expect(screen.queryByText("Test")).toBeNull();
    });
  });

  it("refreshes bot entries when a bot mutation is announced", async () => {
    const initialBot = {
      id: "bot-1",
      name: "Test",
      label: "1:1 アシスタント",
      avatarColor: "#0071E3",
      avatarImage: null,
      enabled: true,
      lastMessageSummary: null,
      lastMessageAt: null,
    };
    const nextBot = { ...initialBot, id: "bot-2", name: "Renamed" };
    let currentBots = [initialBot];
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: [] });
      if (path === "/api/health") {
        return Promise.resolve({
          ok: true,
          engine: "pi",
          engineOk: true,
          version: "1.0.0",
          modelCount: 0,
          dataDir: "C:\\data",
          error: null,
        });
      }
      if (path === "/api/bots/sidebar") return Promise.resolve({ bots: currentBots, rooms: [] });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    mocks.usePathname.mockReturnValue("/bots/bot-1");

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    expect(await screen.findByText("Test")).toBeTruthy();

    currentBots = [nextBot];
    window.dispatchEvent(new Event("webui:bot-sidebar-changed"));

    await waitFor(() => {
      expect(screen.getByText("Renamed")).toBeTruthy();
      expect(screen.queryByText("Test")).toBeNull();
    });
  });

  it("shows the no-project entry even before the first no-project task exists", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?archived=1") return Promise.resolve({ tasks: [] });
      if (path === "/api/health") {
        return Promise.resolve({
          ok: true,
          engine: "pi",
          engineOk: true,
          version: "1.0.0",
          modelCount: 0,
          dataDir: "C:\\data",
          error: null,
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "プロジェクトなしを展開" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "プロジェクトなしで新規タスクを作成" }));
    expect(mocks.retargetToUrl).toHaveBeenCalledWith("home");
  });
});
