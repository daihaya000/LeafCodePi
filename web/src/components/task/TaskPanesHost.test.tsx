// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
});
