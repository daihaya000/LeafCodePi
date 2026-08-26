// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskPane } from "@/lib/task-panes";
import { TASK_DRAG_MIME } from "@/lib/task-drag";

vi.mock("@/components/ui", () => ({
  cx: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));

import { TaskTabs } from "./TaskTabs";

function renderTabs(
  pane: TaskPane,
  overrides: Partial<React.ComponentProps<typeof TaskTabs>> = {},
) {
  return render(
    <TaskTabs
      pane={pane}
      isActivePane
      statusFor={() => null}
      titleFor={(taskId) => taskId}
      canAddPane
      showAddButton
      onActivateTab={vi.fn()}
      onCloseTab={vi.fn()}
      onReorderTabs={vi.fn()}
      onMoveTab={vi.fn()}
      onAddPane={vi.fn()}
      onOpenHome={vi.fn()}
      {...overrides}
    />,
  );
}

describe("TaskTabs actions", () => {
  afterEach(() => cleanup());

  it("同一ペインのタブはドロップ先の前へ挿入する", () => {
    const onReorderTabs = vi.fn();
    renderTabs(
      { id: "pane-1", tabs: ["task-a", "task-b", "task-c"], activeTabId: "task-a" },
      { onReorderTabs },
    );

    const dataTransfer = {
      getData: (type: string) => (type === TASK_DRAG_MIME ? "task-a" : ""),
    } as unknown as DataTransfer;
    fireEvent.drop(screen.getAllByRole("tab")[2], { dataTransfer });

    expect(onReorderTabs).toHaveBeenCalledWith(["task-b", "task-a", "task-c"]);
  });

  it("タブ追加と削除の操作を対応するコールバックへ渡す", () => {
    const onOpenHome = vi.fn();
    const onCloseTab = vi.fn();
    const { rerender } = renderTabs(
      { id: "pane-1", tabs: ["task-a"], activeTabId: "task-a" },
      { onOpenHome, onCloseTab },
    );

    fireEvent.click(screen.getByRole("button", { name: "新規作成タブを開く" }));
    expect(onOpenHome).toHaveBeenCalledOnce();

    rerender(
      <TaskTabs
        pane={{ id: "pane-1", tabs: ["task-a", "task-b"], activeTabId: "task-b" }}
        isActivePane
        statusFor={() => null}
        titleFor={(taskId) => taskId}
        canAddPane
        showAddButton
        onActivateTab={vi.fn()}
        onCloseTab={onCloseTab}
        onReorderTabs={vi.fn()}
        onMoveTab={vi.fn()}
        onAddPane={vi.fn()}
        onOpenHome={onOpenHome}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "タブ task-b を閉じる" }));
    expect(onCloseTab).toHaveBeenCalledWith("task-b");
  });
});
