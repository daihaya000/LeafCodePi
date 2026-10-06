// @vitest-environment happy-dom
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneLayout, TaskPanesState } from "@/lib/task-panes";
import { resetUnreadStateForTests } from "@/lib/bot-unread";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  isTaskDrag: vi.fn(() => false),
  taskDragIdFrom: vi.fn((): string | null => null),
  useTaskPanes: vi.fn(),
  usePathname: vi.fn(() => "/task/active"),
  useSearchParams: vi.fn((): { get: (name: string) => string | null } => ({ get: () => null })),
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
  TaskTabs: ({ pane, onOpenHome, canClosePane, onClearPane }: {
    pane: TaskPanesState["panes"][number];
    onOpenHome: () => void;
    canClosePane: boolean;
    onClearPane: () => void;
  }) => (
    <div
      role="tablist"
      aria-label="タスクと設定のタブ"
      data-testid="task-tabs"
      data-tabs={pane.tabs.join(",")}
      onDragOver={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
    >
      <button type="button" aria-label="新規作成タブを開く" onClick={onOpenHome} />
      {pane.tabs.length === 0 && (
        <button type="button" aria-label="空のペインを閉じる" disabled={!canClosePane} onClick={onClearPane} />
      )}
    </div>
  ),
}));
vi.mock("@/components/ui", () => ({
  cx: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));
vi.mock("@/lib/task-drag", () => ({
  isTaskDrag: mocks.isTaskDrag,
  taskDragIdFrom: mocks.taskDragIdFrom,
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
    mocks.isTaskDrag.mockReturnValue(false);
    mocks.taskDragIdFrom.mockReturnValue(null);
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
    fireEvent(window, new Event("blur"));
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    cleanup();
    localStorage.removeItem("webui:task-pane-prefer-new");
    resetUnreadStateForTests();
    vi.clearAllMocks();
  });

  it("project home selection does not override a sidebar task selection", () => {
    const retargetToUrl = vi.fn();
    const contextValue = {
      ...mocks.useTaskPanes(),
      activeTaskId: "home",
      retargetToUrl,
    };
    mocks.useTaskPanes.mockReturnValue(contextValue);
    mocks.usePathname.mockReturnValue("/");
    mocks.useSearchParams.mockReturnValue({
      get: (name: string) => name === "projectId" ? "project-1" : null,
    });

    const view = render(<TaskPanesHost />);
    retargetToUrl.mockClear();

    mocks.useTaskPanes.mockReturnValue({
      ...contextValue,
      activeTaskId: "existing-task",
    });
    view.rerender(<TaskPanesHost />);

    expect(retargetToUrl).not.toHaveBeenCalled();
  });

  it("retargets to home when the project query changes", () => {
    const retargetToUrl = vi.fn();
    const contextValue = {
      ...mocks.useTaskPanes(),
      activeTaskId: "existing-task",
      retargetToUrl,
    };
    mocks.useTaskPanes.mockReturnValue(contextValue);
    mocks.usePathname.mockReturnValue("/");
    mocks.useSearchParams.mockReturnValue({ get: () => null });

    const view = render(<TaskPanesHost />);
    mocks.useSearchParams.mockReturnValue({
      get: (name: string) => name === "projectId" ? "project-1" : null,
    });
    view.rerender(<TaskPanesHost />);

    expect(retargetToUrl).toHaveBeenCalledTimes(1);
    expect(retargetToUrl).toHaveBeenLastCalledWith("home");
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

  it("複数ペインの空ペインはクリア操作で閉じられる", () => {
    const dispatch = vi.fn();
    const state: TaskPanesState = {
      panes: [
        { id: "pane-1", tabs: ["active"], activeTabId: "active" },
        { id: "pane-2", tabs: [], activeTabId: null },
      ],
      activePaneId: "pane-1",
    };
    mocks.useTaskPanes.mockReturnValue({ ...mocks.useTaskPanes(), state, dispatch });
    render(<TaskPanesHost />);

    const button = screen.getByRole("button", { name: "空のペインを閉じる" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(dispatch).toHaveBeenCalledWith({ type: "clearPane", paneId: "pane-2", keepTabIds: [] });
  });

  it("最後の空ペインはクリア操作で閉じられない", () => {
    const state: TaskPanesState = {
      panes: [{ id: "pane-1", tabs: [], activeTabId: null }],
      activePaneId: "pane-1",
    };
    mocks.useTaskPanes.mockReturnValue({ ...mocks.useTaskPanes(), state, activeTaskId: null });
    render(<TaskPanesHost />);

    const button = screen.getByRole("button", { name: "空のペインを閉じる" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
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

  it("最左ペインの左上から進行中タスクを分割表示できる", async () => {
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
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.closest("[data-pane-id]")?.getAttribute("data-pane-id")).toBe("pane-1");
    expect(buttons[0]?.closest("[data-pane-id]")?.firstElementChild?.contains(buttons[0])).toBe(true);

    fireEvent.click(buttons[0]!);
    expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks?paneCandidates=1");
    await waitFor(() => expect(contextValue.dispatch).toHaveBeenCalledWith({
      type: "showWorkingTasks",
      taskIds: ["newer", "older"],
    }));
  });

  it("分割表示に保存済みのプロジェクト順とピン留めを反映する", async () => {
    const dispatch = vi.fn();
    mocks.useTaskPanes.mockReturnValue({ ...mocks.useTaskPanes(), dispatch });
    mocks.getJson.mockImplementation(async (path: string) => {
      if (path === "/api/settings/sidebar-project-order") return { value: '["b","a"]' };
      if (path === "/api/settings/sidebar-pinned-tasks") return { value: '["pinned"]' };
      if (path === "/api/projects?archived=1") return { projects: [{ id: "a" }, { id: "b" }] };
      if (path === "/api/tasks?paneCandidates=1") return { tasks: [
        { id: "newest", projectId: "a", status: "working", updatedAt: "2026-01-03" },
        { id: "working", projectId: "b", status: "working", updatedAt: "2026-01-02" },
        { id: "pinned", projectId: "b", status: "ready", updatedAt: "2026-01-01" },
        { id: "no-project", projectId: null, status: "working", updatedAt: "2026-01-01" },
      ] };
      return {};
    });
    render(<TaskPanesHost />);
    fireEvent.click(screen.getByRole("button", { name: "進行中タスクを分割表示" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({
      type: "showWorkingTasks", taskIds: ["no-project", "pinned", "working", "newest"],
    }));
  });

  it("Botタブを表示中でも新規作成ボタンはホームを開く", () => {
    mocks.usePathname.mockReturnValue("/bots/one");
    const dispatch = vi.fn();
    mocks.useTaskPanes.mockReturnValue({
      ...mocks.useTaskPanes(),
      state: { panes: [{ id: "pane-1", tabs: ["/bots/one"], activeTabId: "/bots/one" }], activePaneId: "pane-1" },
      activeTaskId: "/bots/one",
      dispatch,
    });

    render(<TaskPanesHost />);
    fireEvent.click(screen.getByRole("button", { name: "新規作成タブを開く" }));

    expect(dispatch).toHaveBeenCalledWith({ type: "openTab", paneId: "pane-1", taskId: "home" });
    mocks.usePathname.mockReturnValue("/task/active");
  });

  it("最左ペインの左上から新規セッション・Botの開き方を切り替えられる", async () => {
    localStorage.setItem("webui:task-pane-prefer-new", "0");
    mocks.useTaskPanes.mockReturnValue({
      ...mocks.useTaskPanes(),
      state: createTreeState(),
    });

    render(<TaskPanesHost />);

    const switches = screen.getAllByRole("switch", {
      name: "新規セッション・Botを新しいペインで開く",
    });
    expect(switches).toHaveLength(1);
    expect(switches[0]?.closest("[data-pane-id]")?.getAttribute("data-pane-id")).toBe("pane-1");
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

  it("ペイン配列の順序ではなくレイアウトの最左ペインにのみ操作を表示する", () => {
    const state = createTreeState();
    mocks.useTaskPanes.mockReturnValue({
      ...mocks.useTaskPanes(),
      state: { ...state, panes: [...state.panes].reverse() },
    });

    render(<TaskPanesHost />);

    expect(screen.getByRole("button", { name: "進行中タスクを分割表示" }).closest("[data-pane-id]")?.getAttribute("data-pane-id")).toBe("pane-1");
    expect(screen.getByRole("switch", { name: "新規セッション・Botを新しいペインで開く" }).closest("[data-pane-id]")?.getAttribute("data-pane-id")).toBe("pane-1");
    expect(screen.getAllByRole("button", { name: "進行中タスクを分割表示" })).toHaveLength(1);
    expect(screen.getAllByRole("switch", { name: "新規セッション・Botを新しいペインで開く" })).toHaveLength(1);
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
      taskIds: ["plain", "/bots/bot-a", "/bots/rooms/room-1"],
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
      if (path === "/api/tasks?paneCandidates=1") return Promise.resolve({ tasks: [] });
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

  it("Codeセッションをサイドバー順に並べて未読Bot・Roomを追加する", async () => {
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
      if (path === "/api/tasks?paneCandidates=1") {
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
      taskIds: ["working", "unread-new", "unread-old", "/bots/rooms/room-1", "/bots/bot-a"],
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

  it.each(["dragOver", "drop"] as const)("タブバーの%sで分割プレビューを解除する", (eventType) => {
    mocks.isTaskDrag.mockReturnValue(true);
    const { container } = render(<TaskPanesHost />);
    const pane = container.querySelector<HTMLElement>("[data-pane-id]")!;
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const dataTransfer = { types: ["application/x-leafcodepi-task"], dropEffect: "move" };
    const dragOver = createEvent.dragOver(pane, { dataTransfer });
    Object.defineProperties(dragOver, { clientX: { value: 5 }, clientY: { value: 400 } });
    fireEvent(pane, dragOver);
    expect(pane.querySelector('[class~="bg-accent/15"]')).not.toBeNull();

    fireEvent[eventType](screen.getByTestId("task-tabs"), { dataTransfer, clientX: 200, clientY: 10 });

    expect(pane.querySelector('[class~="bg-accent/15"]')).toBeNull();
  });

  it("タブバーの余白をドラッグしても本体の端分割プレビューを出さない", () => {
    mocks.isTaskDrag.mockReturnValue(true);
    const { container } = render(<TaskPanesHost />);
    const pane = container.querySelector<HTMLElement>("[data-pane-id]")!;
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const header = pane.firstElementChild!;
    const dragOver = createEvent.dragOver(header, {
      dataTransfer: { types: ["application/x-leafcodepi-task"], dropEffect: "move" },
    });
    Object.defineProperties(dragOver, { clientX: { value: 5 }, clientY: { value: 10 } });

    fireEvent(header, dragOver);

    expect(dragOver.defaultPrevented).toBe(true);
    expect(pane.querySelector('[class~="bg-accent/15"]')).toBeNull();
    expect(pane.className).not.toContain("ring-accent/50");
  });

  it("タブバーの操作領域にドロップしてもペインを分割しない", () => {
    mocks.isTaskDrag.mockReturnValue(true);
    mocks.taskDragIdFrom.mockReturnValue("other-task");
    const dispatch = mocks.useTaskPanes().dispatch;
    const { container } = render(<TaskPanesHost />);
    const pane = container.querySelector<HTMLElement>("[data-pane-id]")!;
    const drop = createEvent.drop(pane.firstElementChild!, {
      dataTransfer: { types: ["application/x-leafcodepi-task"] },
    });

    fireEvent(pane.firstElementChild!, drop);

    expect(drop.defaultPrevented).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("リサイズ中のアンマウントでグローバルイベントとbodyのスタイルを復元する", () => {
    mocks.useTaskPanes.mockReturnValue({ ...mocks.useTaskPanes(), state: createTreeState() });
    const view = render(<TaskPanesHost />);
    const separator = screen.getAllByRole("separator")[0]!;
    vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800,
      x: 0, y: 0, toJSON: () => ({}),
    });
    document.body.style.userSelect = "text";
    document.body.style.cursor = "crosshair";
    const removeListener = vi.spyOn(window, "removeEventListener");
    fireEvent.pointerDown(separator, { clientX: 600, clientY: 400, pointerId: 1 });
    expect(document.body.style.userSelect).toBe("none");

    view.unmount();

    expect(document.body.style.userSelect).toBe("text");
    expect(document.body.style.cursor).toBe("crosshair");
    for (const name of ["pointermove", "pointerup", "pointercancel", "blur"]) {
      expect(removeListener).toHaveBeenCalledWith(name, expect.any(Function));
    }
    removeListener.mockRestore();
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
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
