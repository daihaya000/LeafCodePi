// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "@/lib/types";

const mocks = vi.hoisted(() => ({ timeAgo: vi.fn(() => "now") }));

vi.mock("@/components/ui", () => ({
  cx: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  timeAgo: mocks.timeAgo,
  ThemeToggle: () => null,
}));
vi.mock("@/components/SessionLabelBadge", () => ({ SessionLabelBadge: () => null }));

import { SidebarTaskRow } from "./Sidebar";

const task: TaskSummary = {
  id: "task-1",
  projectId: "project-1",
  projectName: "Project",
  title: "Stable task",
  directory: "C:\\work",
  isolation: "current_folder",
  status: "idle",
  sessionId: null,
  sessionFile: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const callbacks = {
  onOpenTask: vi.fn(),
  onPinTask: vi.fn(),
  onPromoteTask: vi.fn(),
  onArchiveTask: vi.fn(),
  onDragStart: vi.fn(),
};

describe("SidebarTaskRow render stability", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("skips an unchanged session row and rerenders it when its display props change", () => {
    const props = {
      task,
      active: false,
      pinned: false,
      mdUp: true,
      actionBusy: false,
      ...callbacks,
    };
    const view = render(<SidebarTaskRow {...props} />);
    expect(mocks.timeAgo).toHaveBeenCalledTimes(1);

    mocks.timeAgo.mockClear();
    view.rerender(<SidebarTaskRow {...props} />);
    expect(mocks.timeAgo).not.toHaveBeenCalled();

    view.rerender(<SidebarTaskRow {...props} active />);
    expect(mocks.timeAgo).toHaveBeenCalledTimes(1);
  });

  it("keeps session rows eagerly rendered so scrolling does not jank on mobile", () => {
    const view = render(<SidebarTaskRow task={task} active={false} pinned={false} mdUp actionBusy={false} {...callbacks} />);
    const row = view.container.querySelector("li");
    // content-visibility の遅延描画はスクロール時にレイアウトが集中してジャンクになる。
    // 描画行数は Sidebar 側の上限（SIDEBAR_TASK_RENDER_STEP）で抑える。
    expect(row?.className).not.toContain("content-visibility");
    // 行内ボタンのフォーカスリングは内側へ寄せる。
    expect(row?.className).toContain("[&_button:focus-visible]:outline-offset-[-2px]");
  });
});
