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
  useBotStatusFor: () => () => null,
  useTaskPanesNavigation: () => ({
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
  Button: ({ children, busy, ...props }: { children: ReactNode; busy?: boolean; [key: string]: unknown }) => {
    void busy;
    return <button {...props}>{children}</button>;
  },
  cx: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  timeAgo: () => "",
  ThemeToggle: () => null,
}));

import { Sidebar } from "./Sidebar";
import { resetUnreadStateForTests } from "@/lib/bot-unread";

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

async function openProjectSettings() {
  fireEvent.click(await screen.findByRole("button", { name: "Project Aの設定" }));
  return screen.findByRole("dialog", { name: "プロジェクト設定" });
}

/** ネイティブダイアログ対応（Windows ホスト）として health を返す。 */
function useWindowsHost() {
  const base = mocks.getJson.getMockImplementation()!;
  mocks.getJson.mockImplementation((path: string) =>
    path === "/api/health"
      ? Promise.resolve({
          ok: true,
          engine: "pi",
          engineOk: true,
          version: "1.0.0",
          modelCount: 0,
          dataDir: "C:\\data",
          error: null,
          platform: "win32",
        })
      : base(path),
  );
}

/** ホストPCのブラウザ（loopback 制御面に到達できる）を模す。 */
function useLocalHost() {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn()
      .mockResolvedValueOnce(json({ controlUrl: "http://127.0.0.1:18775", path: "C:\\repo-a" }))
      .mockResolvedValueOnce(json({ ok: true, explorer: true })),
  );
}

beforeEach(() => {
  localStorage.clear();
  // These tests exercise the Code sidebar; opt into it explicitly now that Bot is the default.
  localStorage.setItem("leafcodepi.mode", "code");
  mocks.getJson.mockReset().mockImplementation((path: string) => {
    if (path === "/api/projects?archived=1") return Promise.resolve({ projects });
    if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
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
  resetUnreadStateForTests();
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Sidebar project ordering", () => {
  it("defaults to Code mode when no mode is saved", async () => {
    localStorage.removeItem("leafcodepi.mode");
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const modeSegment = screen.getByRole("button", { name: "Code" }).parentElement!;
    const modeButtons = [...modeSegment.querySelectorAll("button")];
    expect(modeButtons.map((button) => button.textContent)).toEqual(["Code", "Bot"]);
    await waitFor(() => expect(modeButtons[0]?.getAttribute("aria-pressed")).toBe("true"));
  });

  it("switches from Code to Bot without opening the Bot home", async () => {
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Code" }).getAttribute("aria-pressed")).toBe("true");
    });
    fireEvent.click(screen.getByRole("button", { name: "Bot" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Bot" }).getAttribute("aria-pressed")).toBe("true");
    });
    expect(mocks.push).not.toHaveBeenCalled();
    expect(localStorage.getItem("leafcodepi.mode")).toBe("bot");
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
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: workingTasks });
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

    localStorage.setItem("webui.sidebar.collapsed", "1");
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "進行中タスクを分割表示" }));
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: "showWorkingTasks",
      taskIds: ["working-new", "working-old"],
    });
  });

  it("shows an unread dot on the matching project", async () => {
    const projectTasks = [{
      id: "unread-a", projectId: "project-a", projectName: "Project A", title: "Unread", directory: "C:\\repo-a", isolation: "current_folder" as const, status: "ready" as const, sessionId: "unread-a", sessionFile: null, createdAt: "", updatedAt: "2026-09-22T00:00:00.000Z",
    }];
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects });
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: projectTasks });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    expect((await screen.findByText("Project A")).closest("button")?.querySelector('[aria-label="未読"]')).toBeTruthy();
    expect(screen.getByText("Project B")).toBeTruthy();
  });

  it("does not show an unread tab marker for a session in an archived project", async () => {
    const archivedProject = { ...projects[1]!, archived: true };
    const projectTasks = [{
      id: "archived-project-task", projectId: archivedProject.id, projectName: archivedProject.name, title: "Hidden", directory: archivedProject.rootPath, isolation: "current_folder" as const, status: "ready" as const, sessionId: "archived-project-task", sessionFile: null, createdAt: "", updatedAt: "2026-09-22T00:00:00.000Z",
    }];
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [projects[0]!, archivedProject] });
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: projectTasks });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    expect((await screen.findByRole("button", { name: "Code" })).querySelector('[class*="bg-accent"]')).toBeNull();
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
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: projectTasks });
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

  it("filters a large synthetic task set in the Sidebar", async () => {
    const benchProjects = Array.from({ length: 100 }, (_, index) => ({
      id: `bench-project-${index}`,
      name: `Bench Project ${index}`,
      rootPath: `C:\\bench-${index}`,
      favorite: false,
      archived: false,
      createdAt: "",
      lastOpenedAt: null,
    }));
    const benchTasks = benchProjects.flatMap((project, projectIndex) =>
      Array.from({ length: 50 }, (_, taskIndex) => ({
        id: `bench-session-${projectIndex}-${taskIndex}`,
        projectId: project.id,
        projectName: project.name,
        title: projectIndex % 10 === 0 && taskIndex === 49
          ? `Needle session ${projectIndex}`
          : `Session ${projectIndex}-${taskIndex}`,
        directory: project.rootPath,
        isolation: "current_folder" as const,
        status: "ready" as const,
        sessionId: `bench-session-${projectIndex}-${taskIndex}`,
        sessionFile: null,
        createdAt: "",
        updatedAt: "2026-09-22T00:00:00.000Z",
      })),
    );
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: benchProjects });
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: benchTasks });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    const initialStart = window.performance.now();
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    const search = await screen.findByRole("textbox", { name: "プロジェクトやセッションを検索" });
    await screen.findByRole("button", { name: "Bench Project 0を展開" });
    const initialMs = window.performance.now() - initialStart;

    const searchStart = window.performance.now();
    fireEvent.change(search, { target: { value: "needle" } });
    await waitFor(() => {
      expect(document.querySelectorAll("[data-project-row]")).toHaveLength(10);
    });
    const searchMs = window.performance.now() - searchStart;
    if (process.env.RUN_SIDEBAR_PERF === "1") {
      console.info(`Sidebar 5k synthetic tasks: initial=${initialMs.toFixed(1)}ms search=${searchMs.toFixed(1)}ms`);
    }
  });

  it("keeps project icon picker constraints aligned with validation", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    const input = (await screen.findByLabelText("Project Aのアイコンを設定")) as HTMLInputElement;
    expect(input.accept.split(",")).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/x-icon",
      "image/vnd.microsoft.icon",
      ".ico",
    ]);

    fireEvent.change(input, {
      target: { files: [new File(["svg"], "icon.svg", { type: "image/svg+xml" })] },
    });
    expect(alert).toHaveBeenCalledWith("PNG・JPEG・GIF・WebP・ICO の画像を選択してください。");

    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })] },
    });
    expect(alert).toHaveBeenCalledWith("2 MB以下の画像を選択してください。");
    expect(mocks.sendJson).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it.each(["image/x-icon", "image/vnd.microsoft.icon"])("accepts a %s project icon", async (type) => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    const input = (await screen.findByLabelText("Project Aのアイコンを設定")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["icon"], "icon.ico", { type })] } });

    await waitFor(() => {
      expect(mocks.sendJson).toHaveBeenCalledWith(
        "/api/projects",
        { id: "project-a", icon: expect.stringContaining(`data:${type};base64,`) },
        "PATCH",
      );
    });
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it("opens the host file dialog at the repository when the host can show it", async () => {
    useWindowsHost();
    useLocalHost();
    const icon = "data:image/x-icon;base64,AAABAA==";
    mocks.sendJson.mockImplementation((path: string) =>
      Promise.resolve(path === "/api/browse/icon" ? { icon } : { project: { ...projects[0], icon } }),
    );
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    fireEvent.click(await screen.findByRole("button", { name: "Project Aのアイコンを設定" }));

    await waitFor(() => {
      expect(mocks.sendJson).toHaveBeenCalledWith(
        "/api/browse/icon",
        { path: "C:\\repo-a" },
        "POST",
        { timeoutMs: 135_000 },
      );
    });
    await waitFor(() => {
      expect(mocks.sendJson).toHaveBeenCalledWith("/api/projects", { id: "project-a", icon }, "PATCH");
    });
  });

  it("falls back to the browser file input when the host dialog fails", async () => {
    useWindowsHost();
    useLocalHost();
    mocks.sendJson.mockRejectedValueOnce(new Error("ネイティブ選択は Windows のみです"));
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    fireEvent.click(await screen.findByRole("button", { name: "Project Aのアイコンを設定" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ネイティブ選択は Windows のみです");
    expect((await screen.findByLabelText("Project Aのアイコンを設定")).tagName).toBe("INPUT");
  });

  it("keeps the host dialog after a rejected image choice", async () => {
    useWindowsHost();
    useLocalHost();
    mocks.sendJson.mockRejectedValueOnce(
      Object.assign(new Error("PNG・JPEG・GIF・WebP・ICO の画像を選択してください。"), { status: 400 }),
    );
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    fireEvent.click(await screen.findByRole("button", { name: "Project Aのアイコンを設定" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("PNG・JPEG・GIF・WebP・ICO の画像を選択してください。");
    expect(screen.queryByRole("button", { name: "Project Aのアイコンを設定" })).not.toBeNull();
  });

  it("keeps the browser file input for a remote client", async () => {
    useWindowsHost();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ controlUrl: "http://127.0.0.1:18775", path: "C:\\repo-a" }))
        .mockRejectedValueOnce(new TypeError("Failed to fetch")),
    );
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    expect((await screen.findByLabelText("Project Aのアイコンを設定")).tagName).toBe("INPUT");
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
    await openProjectSettings();

    const input = (await screen.findByLabelText("Project Aのアイコンを設定")) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["icon"], "icon.png", { type: "image/png" })] },
    });
    reader.onerror?.();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("プロジェクトアイコンの読み込みに失敗しました");
  });

  it("shows a user-facing error when reading a project icon throws synchronously", async () => {
    const reader = {
      result: null,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      readAsDataURL: vi.fn(() => {
        throw new Error("FileReader failed");
      }),
    };
    vi.stubGlobal("FileReader", vi.fn(() => reader));
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    const input = (await screen.findByLabelText("Project Aのアイコンを設定")) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["icon"], "icon.png", { type: "image/png" })] },
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("プロジェクトアイコンの読み込みに失敗しました");
  });

  it("uses the project settings icon as the file picker", async () => {
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    const input = (await screen.findByLabelText("Project Aのアイコンを設定")) as HTMLInputElement;
    const picker = input.parentElement;
    expect(picker?.tagName).toBe("LABEL");
    expect(picker?.title).toBe("Project Aのアイコンを設定");

    const file = new File(["icon"], "icon.png", { type: "image/png" });
    fireEvent.change(input!, { target: { files: [file] } });

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
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledTimes(2));
  });

  it("removes a saved project image from its settings", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") {
        return Promise.resolve({ projects: [{ ...projects[0], icon: "data:image/png;base64,eA==" }, ...projects.slice(1)] });
      }
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    fireEvent.click(screen.getByRole("button", { name: "画像を削除" }));
    await waitFor(() => {
      expect(mocks.sendJson).toHaveBeenCalledWith(
        "/api/projects",
        { id: "project-a", icon: null },
        "PATCH",
      );
    });
  });

  it("marks every non-working project session as read from settings", async () => {
    const projectTasks = [
      { id: "ready", projectId: "project-a", projectName: "Project A", title: "Ready", directory: "C:\\repo-a", isolation: "current_folder" as const, status: "ready" as const, sessionId: "ready", sessionFile: null, createdAt: "", updatedAt: "2026-09-22T00:00:00.000Z" },
      { id: "working", projectId: "project-a", projectName: "Project A", title: "Working", directory: "C:\\repo-a", isolation: "current_folder" as const, status: "working" as const, sessionId: "working", sessionFile: null, createdAt: "", updatedAt: "2026-09-22T00:01:00.000Z" },
      { id: "archived", projectId: "project-a", projectName: "Project A", title: "Archived", directory: "C:\\repo-a", isolation: "current_folder" as const, status: "archived" as const, sessionId: "archived", sessionFile: null, createdAt: "", updatedAt: "2026-09-22T00:02:00.000Z" },
      { id: "other", projectId: "project-b", projectName: "Project B", title: "Other", directory: "C:\\repo-b", isolation: "current_folder" as const, status: "ready" as const, sessionId: "other", sessionFile: null, createdAt: "", updatedAt: "2026-09-22T00:03:00.000Z" },
    ];
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects });
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: projectTasks });
      if (path === "/api/unread") return Promise.resolve({ markers: [{ kind: "task", id: "other", readAt: Date.parse(projectTasks[3]!.updatedAt) }] });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    fireEvent.click(screen.getByRole("button", { name: "Project Aのセッションをすべて既読にする" }));

    await waitFor(() => {
      expect(mocks.sendJson.mock.calls).toEqual(expect.arrayContaining([
        ["/api/unread", { kind: "task", id: "ready", readAt: Date.parse(projectTasks[0]!.updatedAt) }, "PUT"],
        ["/api/unread", { kind: "task", id: "archived", readAt: Date.parse(projectTasks[2]!.updatedAt) }, "PUT"],
      ]));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Code（進行中1件）" })).toBeTruthy());
  });

  it("changes icon color and migrates a project from its settings", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    expect(screen.getAllByRole("button", { name: /^Project Aのアイコン色を/ })).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Project Aのアイコン色を緑に変更" }));
    await waitFor(() => {
      expect(mocks.sendJson).toHaveBeenCalledWith(
        "/api/projects",
        { id: "project-a", iconColor: "green" },
        "PATCH",
      );
    });

    fireEvent.change(screen.getByRole("textbox", { name: "移動先フォルダーのパス" }), {
      target: { value: "C:\\moved-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "移動" }));
    await waitFor(() => {
      expect(mocks.sendJson).toHaveBeenCalledWith(
        "/api/projects",
        { id: "project-a", destinationPath: "C:\\moved-project" },
        "PATCH",
      );
    });
    confirm.mockRestore();
  });

  it("updates the open settings view after saving an icon color", async () => {
    let currentProject = { ...projects[0], iconColor: undefined as string | undefined };
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [currentProject, ...projects.slice(1)] });
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
      if (path === "/api/health") return Promise.resolve({ ok: true, engineOk: true, version: "1", modelCount: 0 });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    mocks.sendJson.mockImplementation(async (_path: string, body: { iconColor?: string }) => {
      currentProject = { ...currentProject, iconColor: body.iconColor as "green" };
      return { project: currentProject };
    });
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    const green = screen.getByRole("button", { name: "Project Aのアイコン色を緑に変更" });
    fireEvent.click(green);

    await waitFor(() => expect(green.getAttribute("aria-pressed")).toBe("true"));
  });

  it("shows icon action errors inside project settings", async () => {
    mocks.sendJson.mockRejectedValueOnce(new Error("アイコン更新に失敗しました"));
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    fireEvent.click(screen.getByRole("button", { name: "Project Aのアイコン色を緑に変更" }));

    expect((await screen.findByRole("alert")).textContent).toContain("アイコン更新に失敗しました");
  });

  it("applies the saved icon color from the patch response", async () => {
    mocks.sendJson.mockResolvedValue({
      project: { ...projects[0], iconColor: "green" },
    });
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    await openProjectSettings();

    const green = screen.getByRole("button", { name: "Project Aのアイコン色を緑に変更" });
    fireEvent.click(green);

    await waitFor(() => expect(green.getAttribute("aria-pressed")).toBe("true"));
  });

  it("keeps project settings reachable from a touch collapsed rail without tasks", async () => {
    localStorage.setItem("webui.sidebar.collapsed", "1");
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Project Aのタスクを表示" }));

    expect(await screen.findByRole("menuitem", { name: "Project Aの設定" })).toBeTruthy();
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

  it("reorders projects when dragging from the project title", async () => {
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    const target = await screen.findByRole("button", { name: "Project Aを展開" });
    const source = (await screen.findByText("Project C")).closest("button") as HTMLElement;
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

    expect(source.getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.drop(targetRow, { dataTransfer, clientY: 10 });

    await waitFor(() => {
      expect(projectOrder()).toEqual(["project-c", "project-a", "project-b"]);
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
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: projectTasks });
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
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: projectTasks });
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
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: projectTasks });
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
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
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
    localStorage.setItem("leafcodepi.mode", "bot");
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
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

  it("refreshes bot entries after navigation and shows the profile label", async () => {
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
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
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
    localStorage.setItem("leafcodepi.mode", "bot");

    const view = render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    expect(await screen.findByText("Test")).toBeTruthy();
    expect(screen.getByText("1:1 アシスタント")).toBeTruthy();

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
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
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
    localStorage.setItem("leafcodepi.mode", "bot");

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);
    expect(await screen.findByText("Test")).toBeTruthy();

    currentBots = [nextBot];
    window.dispatchEvent(new Event("webui:bot-sidebar-changed"));

    await waitFor(() => {
      expect(screen.getByText("Renamed")).toBeTruthy();
      expect(screen.queryByText("Test")).toBeNull();
    });
  });

  it("does not show Bot tasks in the Code project list", async () => {
    const tasks = [
      {
        id: "bot:bot-1",
        kind: "bot" as const,
        projectId: null,
        projectName: "Bots",
        title: "Bot task",
        directory: "C:\\bots\\bot-1",
        isolation: "current_folder" as const,
        status: "idle" as const,
        sessionId: null,
        sessionFile: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "code-1",
        kind: "code" as const,
        projectId: null,
        projectName: "プロジェクトなし",
        title: "Code task",
        directory: "C:\\work",
        isolation: "current_folder" as const,
        status: "idle" as const,
        sessionId: null,
        sessionFile: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks });
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

    fireEvent.click(await screen.findByRole("button", { name: "プロジェクトなしを展開" }));
    expect(await screen.findByText("Code task")).toBeTruthy();
    expect(screen.queryByText("Bot task")).toBeNull();
  });

  it("migrates legacy pins before enabling auto-archive", async () => {
    localStorage.setItem("webui.sidebar.pinned_tasks", JSON.stringify(["legacy-session"]));
    const getJson = mocks.getJson.getMockImplementation()!;
    mocks.getJson.mockImplementation((path: string) =>
      path === "/api/settings/sidebar-pinned-tasks"
        ? Promise.resolve({ value: null })
        : getJson(path),
    );

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      "/api/settings/sidebar-pinned-tasks",
      { value: JSON.stringify(["legacy-session"]) },
      "PUT",
    ));
    await waitFor(() => expect(localStorage.getItem("webui.sidebar.pinned_tasks")).toBeNull());
  });

  it("initializes empty server pins before enabling auto-archive", async () => {
    const getJson = mocks.getJson.getMockImplementation()!;
    mocks.getJson.mockImplementation((path: string) =>
      path === "/api/settings/sidebar-pinned-tasks"
        ? Promise.resolve({ value: null })
        : getJson(path),
    );

    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      "/api/settings/sidebar-pinned-tasks",
      { value: "[]" },
      "PUT",
    ));
  });

  it("loads pinned sessions from the server and saves changes there", async () => {
    const tasks = [{
      id: "session-a",
      projectId: null,
      projectName: "プロジェクトなし",
      title: "Pinned session",
      directory: "C:\\work",
      isolation: "current_folder" as const,
      status: "idle" as const,
      sessionId: "session-a",
      sessionFile: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }];
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks });
      if (path === "/api/settings/sidebar-pinned-tasks") {
        return Promise.resolve({ value: JSON.stringify(["session-a"]) });
      }
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

    fireEvent.click(await screen.findByRole("button", { name: "プロジェクトなしを展開" }));
    const pin = await screen.findByRole("button", { name: "「Pinned session」のピン留めを解除" });
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pin);

    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      "/api/settings/sidebar-pinned-tasks",
      { value: "[]" },
      "PUT",
    ));
    expect(localStorage.getItem("webui.sidebar.pinned_tasks")).toBeNull();
  });

  it("shows the no-project entry even before the first no-project task exists", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [] });
      if (path === "/api/tasks?kind=all" || path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
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

  it("loads archived sessions only after the archive is expanded", async () => {
    render(<Sidebar mobileOpen={false} onClose={vi.fn()} />);

    await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks?kind=all"));
    expect(mocks.getJson).not.toHaveBeenCalledWith("/api/tasks?archived=1&kind=all");

    fireEvent.click(screen.getByRole("button", { name: "アーカイブを展開" }));
    await waitFor(() => {
      expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks?archived=1&kind=all");
    });
  });
});
