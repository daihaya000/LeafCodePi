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

  it("uses content visibility so offscreen session rows skip layout", () => {
    const view = render(<SidebarTaskRow task={task} active={false} pinned={false} mdUp actionBusy={false} {...callbacks} />);
    const row = view.container.querySelector("li");
    expect(row?.className).toContain("[content-visibility:auto]");
    // 未描画行のプレースホルダ高さは実測の行高（約53px）に合わせる。
    expect(row?.className).toContain("[contain-intrinsic-size:auto_3.25rem]");
    // paint containment で行内ボタンのフォーカスリングが欠けないようにする。
    expect(row?.className).toContain("[&_button:focus-visible]:outline-offset-[-2px]");
  });
});
