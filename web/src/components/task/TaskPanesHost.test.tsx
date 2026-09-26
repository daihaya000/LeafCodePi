// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneLayout, TaskPanesState } from "@/lib/task-panes";
import { resetUnreadStateForTests } from "@/lib/bot-unread";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  useTaskPanes: vi.fn(),
  usePathname: vi.fn(() => "/task/active"),
  useSearchParams: vi.fn(() => ({ get: () => null })),
}));

vi.mock("@/lib/client", () => ({ getJson: mocks.getJson }));

vi.mock("@/components/shell/TaskPanesContext", () => ({
  useTaskPanesNavigation: () => {
    const value = mocks.useTaskPanes();
    return {
      state: value.state,
      dispatch: value.dispatch,
      retargetToUrl: value.retargetToUrl,
      activeTaskId: value.activeTaskId,
      mdUp: value.mdUp,
      splitHostEnabled: value.splitHostEnabled,
    };
  },
  useReportStatus: () => mocks.useTaskPanes().reportStatus,
  useGetStatusFor: () => mocks.useTaskPanes().statusFor,
}));
vi.mock("next/navigation", () => ({
  usePathname: mocks.usePathname,
  useSearchParams: mocks.useSearchParams,
}));
vi.mock("next/dynamic", () => ({
  default: () => function DynamicPane({ taskId, id, active }: { taskId?: string; id?: string; active?: boolean }) {
    return <div data-testid="dynamic-pane" data-task-id={taskId} data-bot-id={id} data-active={String(active)} />;
  },
}));
vi.mock("./TaskTabs", () => ({
  paneLayoutClass: () => "layout",
  TaskTabs: ({ pane }: { pane: TaskPanesState["panes"][number] }) => (
    <div
      role="tablist"
      aria-label="タスクと設定のタブ"
      data-testid="task-tabs"
      data-tabs={pane.tabs.join(",")}
    />
  ),
}));
vi.mock("@/components/ui", () => ({
  cx: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));
vi.mock("@/lib/task-drag", () => ({
  isTaskDrag: () => false,
  taskDragIdFrom: () => null,
}));

import { TaskPanesHost } from "./TaskPanesHost";

function createState(): TaskPanesState {
  return {
    panes: [{ id: "pane-1", tabs: ["active", "inactive"], activeTabId: "active" }],
    activePaneId: "pane-1",
  };
}

function createTreeState(): TaskPanesState {
  const panes = Array.from({ length: 4 }, (_, index) => ({
    id: `pane-${index + 1}`,
    tabs: [`task-${index + 1}`],
    activeTabId: `task-${index + 1}`,
  }));
  const leaf = (paneId: string): PaneLayout => ({ type: "pane", paneId });
  return {
    panes,
    activePaneId: "pane-1",
    layout: {
      type: "split",
      id: "root",
      orientation: "column",
      children: [
        {
          type: "split",
          id: "top-row",
          orientation: "row",
          children: [leaf("pane-1"), leaf("pane-2")],
        },
        {
          type: "split",
          id: "bottom-row",
          orientation: "row",
          children: [leaf("pane-3"), leaf("pane-4")],
        },
      ],
    },
  };
}

function createThreePaneState(): TaskPanesState {
  const panes = Array.from({ length: 3 }, (_, index) => ({
    id: `pane-${index + 1}`,
    tabs: [`task-${index + 1}`],
    activeTabId: `task-${index + 1}`,
  }));
  const leaf = (paneId: string): PaneLayout => ({ type: "pane", paneId });
  return {
    panes,
    activePaneId: "pane-1",
    layout: {
      type: "split",
      id: "root",
      orientation: "row",
      children: [
        {
          type: "split",
          id: "left",
          orientation: "row",
          children: [leaf("pane-1"), leaf("pane-2")],
        },
        leaf("pane-3"),
      ],
    },
  };
}

describe("TaskPanesHost lazy tab mounting", () => {
  beforeEach(() => {
    mocks.getJson.mockResolvedValue({ tasks: [] });
    mocks.useTaskPanes.mockReturnValue({
      state: createState(),
      statusFor: () => null,
      reportStatus: vi.fn(),
      dispatch: vi.fn(),
      retargetToUrl: vi.fn(),
      activeTaskId: "active",
      titleFor: () => null,
      mdUp: true,
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem("webui:task-pane-prefer-new");
    resetUnreadStateForTests();
    vi.clearAllMocks();
  });

  it("単一タブのCode・Home・設定・Bot一覧でもタブバーを表示する", () => {
    const cases = [
      { pathname: "/task/active", tabId: "active" },
      { pathname: "/", tabId: "home" },
      { pathname: "/settings", tabId: "settings" },
      { pathname: "/bots", tabId: "/bots" },
    ] as const;

    for (const { pathname, tabId } of cases) {
      mocks.usePathname.mockReturnValue(pathname);
      const state: TaskPanesState = {
        panes: [{ id: "pane-1", tabs: [tabId], activeTabId: tabId }],
        activePaneId: "pane-1",
      };
      mocks.useTaskPanes.mockReturnValue({
        ...mocks.useTaskPanes(),
        state,
        activeTaskId: tabId,
      });

      const view = render(<TaskPanesHost />);
      expect(screen.getByTestId("task-tabs").getAttribute("data-tabs")).toBe(tabId);
      view.unmount();
    }
  });

  it("Bot tabs retain hidden mounts and receive visibility", async () => {
    mocks.usePathname.mockReturnValue("/bots/one");
    const state = { panes: [{ id: "pane-1", tabs: ["/bots/one", "/bots/rooms/two"], activeTabId: "/bots/one" }], activePaneId: "pane-1" };
    mocks.useTaskPanes.mockReturnValue({ ...mocks.useTaskPanes(), state, activeTaskId: "/bots/one" });
    const view = render(<TaskPanesHost />);
    await waitFor(() => expect(screen.getByTestId("dynamic-pane").getAttribute("data-bot-id")).toBe("one"));
    mocks.useTaskPanes.mockReturnValue({ ...mocks.useTaskPanes(), state: { ...state, panes: [{ ...state.panes[0], activeTabId: "/bots/rooms/two" }] } });
    view.rerender(<TaskPanesHost />);
    await waitFor(() => expect(screen.getAllByTestId("dynamic-pane")).toHaveLength(2));
    expect(screen.getAllByTestId("dynamic-pane")[0].getAttribute("data-active")).toBe("false");
    expect(screen.getAllByTestId("dynamic-pane")[1].getAttribute("data-bot-id")).toBe("two");
    mocks.usePathname.mockReturnValue("/task/active");
  });

  it("初回はアクティブタブだけをマウントする", async () => {
    render(<TaskPanesHost />);

    await waitFor(() => {
      expect(screen.getAllByTestId("dynamic-pane")).toHaveLength(1);
    });
    expect(screen.getByTestId("dynamic-pane").getAttribute("data-task-id")).toBe("active");
  });

  it("各ペインの左上から進行中タスクを分割表示できる", async () => {
    const contextValue = {
      state: createTreeState(),
      statusFor: () => null,
      reportStatus: vi.fn(),
      dispatch: vi.fn(),
      retargetToUrl: vi.fn(),
      activeTaskId: "task-1",
      titleFor: () => null,
      mdUp: true,
    };
    mocks.useTaskPanes.mockReturnValue(contextValue);
    mocks.getJson.mockResolvedValue({
      tasks: [
        { id: "older", status: "working", updatedAt: "2026-01-01T00:01:00.000Z" },
        { id: "done", status: "idle", updatedAt: "2026-01-01T00:03:00.000Z" },
        { id: "newer", status: "working", updatedAt: "2026-01-01T00:02:00.000Z" },
      ],
      markers: [{ kind: "task", id: "done", readAt: Date.parse("2026-01-01T00:04:00.000Z") }],
    });

    render(<TaskPanesHost />);

    const buttons = screen.getAllByRole("button", { name: "進行中タスクを分割表示" });
    expect(buttons).toHaveLength(4);
    expect(buttons[0]?.closest("[data-pane-id]")?.firstElementChild?.contains(buttons[0])).toBe(true);

    fireEvent.click(buttons[0]!);
    expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks?archived=1&kind=all");
    await waitFor(() => expect(contextValue.dispatch).toHaveBeenCalledWith({
      type: "showWorkingTasks",
      taskIds: ["newer", "older"],
    }));
  });

  it("各ペインの左上から新規セッション・Botの開き方を切り替えられる", async () => {
    localStorage.setItem("webui:task-pane-prefer-new", "0");
    mocks.useTaskPanes.mockReturnValue({
      ...mocks.useTaskPanes(),
      state: createTreeState(),
    });

    render(<TaskPanesHost />);

    const switches = screen.getAllByRole("switch", {
      name: "新規セッション・Botを新しいペインで開く",
    });
    expect(switches).toHaveLength(4);
    expect(switches[0]?.closest("[data-pane-id]")?.firstElementChild?.contains(switches[0])).toBe(true);
    expect(switches[0]?.getAttribute("aria-checked")).toBe("false");
    expect(switches[0]?.querySelector("svg")).not.toBeNull();
    expect(switches[0]?.className).toContain("text-muted");
    expect(switches[0]?.getAttribute("title")).toBe("新しいペインを優先");

    fireEvent.click(switches[0]!);

    await waitFor(() => {
      expect(localStorage.getItem("webui:task-pane-prefer-new")).toBe("1");
      expect(switches[0]?.getAttribute("aria-checked")).toBe("true");
      expect(switches[0]?.className).toContain("text-accent");
      // ツールチップは状態に依存せず固定
      expect(switches[0]?.getAttribute("title")).toBe("新しいペインを優先");
    });
  });

  it("進行中のBotとBot紐づけCodeはBotViewタブへ寄せる", async () => {
    const contextValue = {
      state: createTreeState(),
      statusFor: () => null,
      reportStatus: vi.fn(),
      dispatch: vi.fn(),
      retargetToUrl: vi.fn(),
      activeTaskId: "task-1",
      titleFor: () => null,
      mdUp: true,
    };
    mocks.useTaskPanes.mockReturnValue(contextValue);
    mocks.getJson.mockResolvedValue({
      tasks: [
        { id: "code-linked", kind: "code", botId: "bot-a", status: "working", updatedAt: "2026-01-01T00:03:00.000Z" },
        { id: "bot:bot-a", kind: "bot", botId: "bot-a", status: "working", updatedAt: "2026-01-01T00:02:00.000Z" },
        { id: "plain", kind: "code", status: "working", updatedAt: "2026-01-01T00:01:00.000Z" },
        { id: "bot:bot-a:room:room-1", kind: "bot", botId: "bot-a", status: "working", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });

    render(<TaskPanesHost />);
    fireEvent.click(screen.getAllByRole("button", { name: "進行中タスクを分割表示" })[0]!);

    await waitFor(() => expect(contextValue.dispatch).toHaveBeenCalledWith({
      type: "showWorkingTasks",
      taskIds: ["/bots/bot-a", "plain", "/bots/rooms/room-1"],
    }));
  });

  it("includes a Bot-owned Code request before its task is persisted", async () => {
    const contextValue = {
      state: createTreeState(),
      statusFor: () => null,
      reportStatus: vi.fn(),
      dispatch: vi.fn(),
      retargetToUrl: vi.fn(),
      activeTaskId: "task-1",
      titleFor: () => null,
      mdUp: true,
    };
    mocks.useTaskPanes.mockReturnValue(contextValue);
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/tasks?archived=1&kind=all") return Promise.resolve({ tasks: [] });
      if (path === "/api/bots/sidebar") return Promise.resolve({ bots: [{ id: "bot-a", codeInProgress: true }] });
      return Promise.resolve({});
    });

    render(<TaskPanesHost />);
    fireEvent.click(screen.getAllByRole("button", { name: "進行中タスクを分割表示" })[0]!);

    await waitFor(() => expect(contextValue.dispatch).toHaveBeenCalledWith({
      type: "showWorkingTasks",
      taskIds: ["/bots/bot-a"],
    }));
  });

  it("未読セッションを進行中タスクの後ろへ新しい順で追加する", async () => {
    const contextValue = {
      state: createTreeState(),
      statusFor: () => null,
      reportStatus: vi.fn(),
      dispatch: vi.fn(),
      retargetToUrl: vi.fn(),
      activeTaskId: "task-1",
      titleFor: () => null,
      mdUp: true,
    };
    mocks.useTaskPanes.mockReturnValue(contextValue);
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/tasks?archived=1&kind=all") {
        return Promise.resolve({
          tasks: [
            { id: "working", status: "working", updatedAt: "2026-01-01T00:00:00.000Z" },
            { id: "unread-old", status: "idle", updatedAt: "2026-01-01T00:01:00.000Z" },
            { id: "unread-new", status: "idle", updatedAt: "2026-01-01T00:05:00.000Z" },
            { id: "read", status: "idle", updatedAt: "2026-01-01T00:06:00.000Z" },
            { id: "archived", status: "archived", updatedAt: "2026-01-01T00:07:00.000Z" },
            { id: "in-archived-project", status: "idle", projectId: "p-old", updatedAt: "2026-01-01T00:08:00.000Z" },
          ],
        });
      }
      if (path === "/api/bots/sidebar") {
        return Promise.resolve({
          bots: [{ id: "bot-a", lastMessageAt: "2026-01-01T00:03:00.000Z" }],
          rooms: [{ id: "room-1", lastMessageAt: "2026-01-01T00:04:00.000Z" }],
        });
      }
      if (path === "/api/projects?archived=1") return Promise.resolve({ projects: [{ id: "p-old", archived: true }] });
      if (path === "/api/unread") {
        return Promise.resolve({ markers: [{ kind: "task", id: "read", readAt: Date.parse("2026-01-01T00:09:00.000Z") }] });
      }
      return Promise.resolve({});
    });

    render(<TaskPanesHost />);
    fireEvent.click(screen.getAllByRole("button", { name: "進行中タスクを分割表示" })[0]!);

    await waitFor(() => expect(contextValue.dispatch).toHaveBeenCalledWith({
      type: "showWorkingTasks",
      taskIds: ["working", "unread-new", "/bots/rooms/room-1", "/bots/bot-a", "unread-old"],
    }));
  });

  it("stored bot: tabs mount BotView instead of TaskView", async () => {
    mocks.usePathname.mockReturnValue("/task/bot%3Aone");
    mocks.useTaskPanes.mockReturnValue({
      ...mocks.useTaskPanes(),
      state: { panes: [{ id: "pane-1", tabs: ["bot:one"], activeTabId: "bot:one" }], activePaneId: "pane-1" },
      activeTaskId: "bot:one",
    });

    render(<TaskPanesHost />);
    await waitFor(() => expect(screen.getByTestId("dynamic-pane").getAttribute("data-bot-id")).toBe("one"));
    expect(screen.getByTestId("dynamic-pane").getAttribute("data-task-id")).toBeNull();
    mocks.usePathname.mockReturnValue("/task/active");
  });

  it("3 ペインは初期表示で各ペインを均等幅にする", () => {
    mocks.useTaskPanes.mockReturnValue({
      state: createThreePaneState(),
      statusFor: () => null,
      reportStatus: vi.fn(),
      dispatch: vi.fn(),
      retargetToUrl: vi.fn(),
      activeTaskId: "task-1",
      titleFor: () => null,
      mdUp: true,
    });

    const { container } = render(<TaskPanesHost />);
    const flexChildren = Array.from(container.querySelectorAll<HTMLElement>("div")).filter(
      (element) => element.style.flexGrow !== "",
    );
    expect(flexChildren).toHaveLength(4);
    expect(Number(flexChildren[0]?.style.flexGrow)).toBeCloseTo(2 / 3);
    expect(Number(flexChildren[1]?.style.flexGrow)).toBeCloseTo(1 / 2);
    expect(Number(flexChildren[2]?.style.flexGrow)).toBeCloseTo(1 / 2);
    expect(Number(flexChildren[3]?.style.flexGrow)).toBeCloseTo(1 / 3);
  });

  it("分割ツリーでは各境界を表示し、上下境界を局所的に高さとして操作できる", () => {
    const contextValue = {
      state: createTreeState(),
      statusFor: () => null,
      reportStatus: vi.fn(),
      dispatch: vi.fn(),
      retargetToUrl: vi.fn(),
      activeTaskId: "task-1",
      titleFor: () => null,
      mdUp: true,
    };
    mocks.useTaskPanes.mockReturnValue(contextValue);

    const { container } = render(<TaskPanesHost />);
    const host = container.firstElementChild as HTMLElement;
    Object.defineProperty(host, "clientWidth", { configurable: true, value: 1200 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 800 });

    const separators = screen.getAllByRole("separator");
    expect(separators).toHaveLength(3);
    const rowHandle = separators.find(
      (separator) => separator.getAttribute("aria-orientation") === "horizontal",
    );
    expect(rowHandle).toBeDefined();
    expect(rowHandle?.getAttribute("aria-label")).toBe("ペイン 1〜2 と ペイン 3〜4 の高さを調整");
    Object.defineProperty(rowHandle?.parentElement, "clientHeight", {
      configurable: true,
      value: 800,
    });

    fireEvent.keyDown(rowHandle!, { key: "ArrowDown" });
    expect(rowHandle?.getAttribute("aria-valuenow")).toBe("52");
    expect(host.style.gridTemplateRows).toBe("");
  });

  it("ペイン区切り線とペイン内オーバーレイをフローティングUIより下の層に置く", () => {
    mocks.useTaskPanes.mockReturnValue({
      state: createTreeState(),
      statusFor: () => null,
      reportStatus: vi.fn(),
      dispatch: vi.fn(),
      retargetToUrl: vi.fn(),
      activeTaskId: "task-1",
      titleFor: () => null,
      mdUp: true,
    });

    const { container } = render(<TaskPanesHost />);
    const panes = container.querySelectorAll("[data-pane-id]");
    expect(panes).toHaveLength(4);
    for (const pane of panes) {
      // isolate でペイン内の z-index を閉じ込め、区切り線を常にペイン内容より上に保つ。
      expect(pane.className).toContain("isolate");
    }
    // 区切り線は 40。ポップオーバー（ModelSelect は z-50）より下なのでメニューにかぶらない。
    for (const handle of screen.getAllByRole("separator")) {
      expect(handle.className).toContain("z-40");
    }
  });

  it("分割ブランチの子ラッパーが縦方向のflex高さを伝播する", () => {
    mocks.useTaskPanes.mockReturnValue({
      state: createTreeState(),
      statusFor: () => null,
      reportStatus: vi.fn(),
      dispatch: vi.fn(),
      retargetToUrl: vi.fn(),
      activeTaskId: "task-1",
      titleFor: () => null,
      mdUp: true,
    });

    const { container } = render(<TaskPanesHost />);
    const panes = container.querySelectorAll("[data-pane-id]");
    expect(panes).toHaveLength(4);
    for (const pane of panes) {
      const branchWrapper = pane.parentElement;
      expect(branchWrapper?.className).toContain("flex-col");
      expect(branchWrapper?.className).toContain("overflow-hidden");
    }
  });

  it("モバイルではURLタスクだけを表示し、デスクトップ復帰後はアクティブタブを表示する", async () => {
    const contextValue = {
      state: createState(),
      statusFor: () => null,
      reportStatus: vi.fn(),
      dispatch: vi.fn(),
      retargetToUrl: vi.fn(),
      activeTaskId: "active",
      titleFor: () => null,
      mdUp: false,
    };
    mocks.useTaskPanes.mockReturnValue(contextValue);

    const { rerender } = render(<TaskPanesHost />);
    expect(screen.getAllByTestId("dynamic-pane")).toHaveLength(1);
    expect(screen.getByTestId("dynamic-pane").getAttribute("data-task-id")).toBe("active");

    mocks.useTaskPanes.mockReturnValue({ ...contextValue, mdUp: true });
    rerender(<TaskPanesHost />);
    await waitFor(() => {
      expect(screen.getAllByTestId("dynamic-pane")).toHaveLength(1);
    });
    expect(screen.getByTestId("dynamic-pane").getAttribute("data-task-id")).toBe("active");
  });
});
