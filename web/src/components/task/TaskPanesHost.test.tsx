// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskPanesState } from "@/lib/task-panes";

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
  default: () => function DynamicPane({ taskId }: { taskId?: string }) {
    return <div data-testid="dynamic-pane" data-task-id={taskId} />;
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

function createGridState(): TaskPanesState {
  return {
    panes: Array.from({ length: 4 }, (_, index) => ({
      id: `pane-${index + 1}`,
      tabs: [`task-${index + 1}`],
      activeTabId: `task-${index + 1}`,
    })),
    activePaneId: "pane-1",
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

  it("初回はアクティブタブだけをマウントする", async () => {
    render(<TaskPanesHost />);

    await waitFor(() => {
      expect(screen.getAllByTestId("dynamic-pane")).toHaveLength(1);
    });
    expect(screen.getByTestId("dynamic-pane").getAttribute("data-task-id")).toBe("active");
  });

  it("4分割では列と行のリサイズを表示し、行ハンドルを高さとして操作できる", () => {
    const contextValue = {
      state: createGridState(),
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
    expect(separators).toHaveLength(2);
    const rowHandle = separators.find(
      (separator) => separator.getAttribute("aria-orientation") === "horizontal",
    );
    expect(rowHandle).toBeDefined();
    expect(rowHandle?.getAttribute("aria-label")).toBe("ペイン 1 と 2 の高さを調整");

    fireEvent.keyDown(rowHandle!, { key: "ArrowDown" });
    expect(rowHandle?.getAttribute("aria-valuenow")).toBe("52");
    expect(host.style.gridTemplateRows).toBe("0.52fr 0.48fr");
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
