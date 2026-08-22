"use client";

import dynamic from "next/dynamic";
import { useTaskPanes } from "@/components/shell/TaskPanesContext";
import { cx } from "@/components/ui";

const SplitTaskView = dynamic(
  () => import("@/components/task/TaskView").then((module) => module.TaskView),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        className="flex h-full items-center justify-center text-xs text-muted"
      >
        タスクを読み込み中...
      </div>
    ),
  },
);

/**
 * task path でのみ内容を返す描画ホスト。Home/settings では null を返すだけで
 * Provider の panes state・SSE は保持される（仕様 §7 の panes 保持方式）。
 * Phase 2 時点: 1 ペイン × アクティブタブのみ描画（タブバーは Phase 3）。
 */
export function TaskPanesHost() {
  const { state, splitHostEnabled, mdUp } = useTaskPanes();
  if (!splitHostEnabled || !mdUp) return null;

  const activePane =
    state.panes.find((pane) => pane.id === state.activePaneId) ?? state.panes[0];
  if (!activePane?.activeTabId) return null;

  return (
    <div
      className={cx(
        "flex min-h-0 min-w-0 flex-1",
        // Phase 3 で N ペイン化。現状は単一ペインのみ
      )}
    >
      <SplitTaskView key={activePane.activeTabId} taskId={activePane.activeTabId} />
    </div>
  );
}
