"use client";

import { useState } from "react";
import { Loader2, Plus, SquarePen, X } from "lucide-react";
import { cx } from "@/components/ui";
import { setTaskDragData, taskDragIdFrom, TASK_DRAG_MIME } from "@/lib/task-drag";
import { HOME_TAB_ID, type TaskPane, type TaskPanesState } from "@/lib/task-panes";
import type { TaskStatus } from "@/lib/types";

/**
 * タブバー 1 本。仕様 §6: タイトル省略 + hover フルタイトル、status バッジ
 * （working = スピン / error = 赤点）、× ボタン、右端 + = 空ペイン追加。
 * ペイン全体（空ペイン含む）へのドロップもタブバー扱い。
 */
export function TaskTabs({
  pane,
  isActivePane,
  statusFor,
  titleFor,
  canAddPane,
  showAddButton,
  onActivateTab,
  onCloseTab,
  onReorderTabs,
  onMoveTab,
  onAddPane,
  onOpenHome,
}: {
  pane: TaskPane;
  isActivePane: boolean;
  /** taskId → 最新 status（Provider の報告 map）。 */
  statusFor: (taskId: string) => TaskStatus | null;
  /** taskId → セッション名（タスク title）。未取得なら null。 */
  titleFor?: (taskId: string) => string | null;
  canAddPane: boolean;
  /** + ボタンは最後のペインのタブバーのみ（仕様 §6）。 */
  showAddButton: boolean;
  onActivateTab: (taskId: string) => void;
  onCloseTab: (taskId: string) => void;
  onReorderTabs: (tabs: string[]) => void;
  onMoveTab: (taskId: string, toPaneId: string) => void;
  onAddPane: () => void;
  /** 新規作成（Home）タブをこのペインに開く（既にあれば活性化）。 */
  onOpenHome: () => void;
}) {
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDrop = (event: React.DragEvent<HTMLElement>, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverIndex(null);
    const taskId = taskDragIdFrom(event.dataTransfer);
    if (!taskId) return;
    if (pane.tabs.includes(taskId)) {
      // 同一ペイン内の並び替え（ドロップ先の前へ挿入）
      const sourceIndex = pane.tabs.indexOf(taskId);
      const without = pane.tabs.filter((id) => id !== taskId);
      const targetIndex = index > sourceIndex ? index - 1 : index;
      const at = Math.max(0, Math.min(targetIndex, without.length));
      onReorderTabs([...without.slice(0, at), taskId, ...without.slice(at)]);
      return;
    }
    // 他ペインのタブ、または Sidebar からの新規ドロップを親で解決する。
    onMoveTab(taskId, pane.id);
  };

  return (
    <div
      role="tablist"
      aria-label="タスクタブ"
      className="flex min-h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-border bg-surface px-1 pt-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(TASK_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => handleDrop(event, pane.tabs.length)}
    >
      {pane.tabs.map((taskId, index) => {
        const status = statusFor(taskId);
        const active = pane.activeTabId === taskId;
        // セッション名（タスク title）。未取得の間は taskId をフォールバック表示。
        // 新規作成（Home）タブは固定ラベル。
        const label = taskId === HOME_TAB_ID ? "新規作成" : (titleFor?.(taskId) ?? taskId);
        return (
          <div
            key={taskId}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            draggable
            onDragStart={(event) => {
              setTaskDragData(event.dataTransfer, taskId);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(TASK_DRAG_MIME)) return;
              event.preventDefault();
              event.stopPropagation();
              setDragOverIndex(index);
            }}
            onDrop={(event) => handleDrop(event, index)}
            onDragLeave={() => setDragOverIndex((current) => (current === index ? null : current))}
            onDragEnd={() => setDragOverIndex(null)}
            onClick={() => onActivateTab(taskId)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onActivateTab(taskId);
              }
            }}
            title={label}
            className={cx(
              "group/tab flex min-w-0 max-w-40 shrink cursor-pointer select-none items-center gap-1 rounded-t-md border border-b-0 px-2 py-1 text-xs",
              active
                ? "border-border bg-bg font-medium text-text"
                : "border-transparent bg-surface-2/50 text-muted hover:bg-surface-2 hover:text-text",
              isActivePane ? "" : "opacity-70",
              dragOverIndex === index && "ring-1 ring-accent",
            )}
          >
            {status === "working" && (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-working" aria-hidden="true" />
            )}
            {status === "error" && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-label="エラー" />
            )}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <button
              type="button"
              aria-label={`タブ ${label} を閉じる`}
              className="-mr-1 hidden h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-surface-3 group-hover/tab:inline-flex focus-visible:inline-flex [@media(hover:none)]:inline-flex"
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(taskId);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="新規作成タブを開く"
        title="新規作成（ホーム）タブを開く"
        onClick={onOpenHome}
        className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
      >
        <SquarePen className="h-4 w-4" />
      </button>
      {showAddButton && (
        <button
          type="button"
          aria-label="新しいペインを追加"
          title={canAddPane ? "空のペインを追加（タスクをドロップして開く）" : "ペイン数の上限です"}
          disabled={!canAddPane}
          onClick={onAddPane}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function paneLayoutClass(state: TaskPanesState): string {
  // レイアウト自動切替（仕様 §1）: 4 ペイン = 2x2 grid、それ以外 = orientation 方向の並び
  if (state.panes.length >= 4) return "grid min-h-0 min-w-0 flex-1 grid-cols-2 grid-rows-2";
  return state.orientation === "column"
    ? "flex min-h-0 min-w-0 flex-1 flex-col"
    : "flex min-h-0 min-w-0 flex-1";
}
