"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useTaskPanes } from "@/components/shell/TaskPanesContext";
import { cx } from "@/components/ui";
import { isTaskDrag, taskDragIdFrom } from "@/lib/task-drag";
import { taskIdFromPathname } from "@/lib/task-panes";
import { paneLayoutClass, TaskTabs } from "./TaskTabs";

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
 *
 * hidden mount（仕様 §4）: 各ペイン内の全タブの TaskView を render し、
 * 非アクティブは CSS hidden。key={taskId} でインスタンスと SSE を維持する。
 * 1 ペイン × 1 タブではタブバーを表示しない（仕様 §1 の従来通り）。
 */
export function TaskPanesHost() {
  const { state, statusFor, reportStatus, dispatch, splitHostEnabled, mdUp } = useTaskPanes();
  const pathname = usePathname();
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null);
  if (!splitHostEnabled) return null;

  // md 未満: 分割・タブは無効で URL タスクのみ単一表示（仕様 §1 のフォールバック）。
  // モバイルでは Provider の panes/復元を触らず、URL 由来の taskId を直接 render する。
  if (!mdUp) {
    const urlTaskId = taskIdFromPathname(pathname);
    if (!urlTaskId) return null;
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <SplitTaskView taskId={urlTaskId} onStatus={(status) => reportStatus(urlTaskId, status)} />
      </div>
    );
  }

  const activePaneId =
    state.panes.find((pane) => pane.id === state.activePaneId)?.id ?? state.panes[0]?.id ?? null;
  if (!activePaneId) return null;

  const single = state.panes.length === 1 && state.panes[0].tabs.length <= 1;
  const isGrid = state.panes.length >= 4;

  return (
    <div className={paneLayoutClass(state)}>
      {state.panes.map((pane, paneIndex) => (
        <section
          key={pane.id}
          data-pane-id={pane.id}
          data-active={pane.id === activePaneId ? "true" : "false"}
          aria-label={`タスクペイン ${paneIndex + 1}`}
          className={cx(
            "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
            !single && "border-border",
            !single && !isGrid && "flex-1",
            // 横並び: 左隣との境界 / grid: 右列・下段に罫線
            !single && !isGrid && paneIndex > 0 && "border-l",
            !single && isGrid && paneIndex % 2 === 1 && "border-l",
            !single && isGrid && paneIndex >= 2 && "border-t",
            dragOverPaneId === pane.id && "ring-1 ring-inset ring-accent/50",
          )}
          onDragOver={(event) => {
            if (!isTaskDrag(event.dataTransfer.types)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDragOverPaneId(pane.id);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragOverPaneId((current) => (current === pane.id ? null : current));
          }}
          onDrop={(event) => {
            if (!isTaskDrag(event.dataTransfer.types)) return;
            event.preventDefault();
            event.stopPropagation();
            setDragOverPaneId(null);
            const taskId = taskDragIdFrom(event.dataTransfer);
            if (!taskId) return;
            const source = state.panes.find((p) => p.tabs.includes(taskId));
            if (source && source.id !== pane.id) {
              dispatch({ type: "moveTab", fromPaneId: source.id, toPaneId: pane.id, taskId });
            } else {
              dispatch({ type: "openTab", paneId: pane.id, taskId });
            }
          }}
          onPointerDown={() => {
            if (pane.id !== activePaneId) dispatch({ type: "activatePane", paneId: pane.id });
          }}
          onFocusCapture={() => {
            if (pane.id !== activePaneId) dispatch({ type: "activatePane", paneId: pane.id });
          }}
        >
          {!single && (
            <TaskTabs
              pane={pane}
              isActivePane={pane.id === activePaneId}
              statusFor={statusFor}
              canAddPane={state.panes.length < 4}
              showAddButton={pane.id === state.panes[state.panes.length - 1].id}
              onActivateTab={(taskId) => dispatch({ type: "activateTab", paneId: pane.id, taskId })}
              onCloseTab={(taskId) => dispatch({ type: "closeTab", paneId: pane.id, taskId })}
              onReorderTabs={(tabs) => dispatch({ type: "reorderTabs", paneId: pane.id, tabs })}
              onMoveTab={(taskId, toPaneId) => {
                const source = state.panes.find((p) => p.tabs.includes(taskId));
                if (source && source.id !== toPaneId) {
                  dispatch({ type: "moveTab", fromPaneId: source.id, toPaneId, taskId });
                }
              }}
              onOpenTabExternal={(taskId) => dispatch({ type: "openTab", paneId: pane.id, taskId })}
              onAddPane={() => dispatch({ type: "addPane" })}
            />
          )}
          {/* アクティブペインのアクセント線（仕様 §6） */}
          {pane.id === activePaneId && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-[70] h-0.5 bg-accent"
            />
          )}
          {pane.tabs.map((taskId) => {
            const isActiveTab = pane.activeTabId === taskId && pane.id === activePaneId;
            return (
              <SplitTaskView
                key={taskId}
                taskId={taskId}
                active={isActiveTab}
                onStatus={(status) => reportStatus(taskId, status)}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}
