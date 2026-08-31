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
  activeTaskId: null as string | null,
}));

vi.mock("@/lib/client", () => ({
  getJson: mocks.getJson,
  sendJson: mocks.sendJson,
}));
vi.mock("@/lib/events", () => ({ notifyTasksChanged: vi.fn() }));
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
  mocks.retargetToUrl.mockReset();
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
