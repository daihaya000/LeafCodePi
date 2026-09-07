// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneLayout, TaskPanesState } from "@/lib/task-panes";

const mocks = vi.hoisted(() => ({
  useTaskPanes: vi.fn(),
  usePathname: vi.fn(() => "/task/active"),
  useSearchParams: vi.fn(() => ({ get: () => null })),
}));

vi.mock("@/components/shell/TaskPanesContext", () => ({
  useTaskPanes: mocks.useTaskPanes,
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
  TaskTabs: () => null,
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
    vi.clearAllMocks();
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
