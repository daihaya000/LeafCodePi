"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTaskPanes } from "@/components/shell/TaskPanesContext";
import { cx } from "@/components/ui";
import { isTaskDrag, taskDragIdFrom } from "@/lib/task-drag";
import { resizeAdjacentPaneWidths, taskIdFromPathname } from "@/lib/task-panes";
import { paneLayoutClass, TaskTabs } from "./TaskTabs";

const MIN_PANE_WIDTH = 240;

function equalPaneWidths(count: number): number[] {
  return count > 0 ? Array.from({ length: count }, () => 1 / count) : [];
}

function PaneResizeHandle({
  boundaryIndex,
  position,
  widths,
  containerRef,
  onResize,
}: {
  boundaryIndex: number;
  position: number;
  widths: readonly number[];
  containerRef: { current: HTMLDivElement | null };
  onResize: (widths: number[]) => void;
}) {
  const pairTotal = widths[boundaryIndex]! + widths[boundaryIndex + 1]!;
  const currentWidth = widths[boundaryIndex]!;
  const minimumFor = (containerWidth: number) =>
    Math.min(MIN_PANE_WIDTH / Math.max(containerWidth, MIN_PANE_WIDTH), pairTotal / 2);

  const resizeBy = (delta: number, containerWidth: number, startWidths = widths) => {
    onResize(resizeAdjacentPaneWidths(startWidths, boundaryIndex, delta, minimumFor(containerWidth)));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`ペイン ${boundaryIndex + 1} と ${boundaryIndex + 2} の幅を調整`}
      aria-valuemin={Math.round(minimumFor(containerRef.current?.clientWidth ?? 0) * 100)}
      aria-valuemax={Math.round((pairTotal - minimumFor(containerRef.current?.clientWidth ?? 0)) * 100)}
      aria-valuenow={Math.round(currentWidth * 100)}
      tabIndex={0}
      className="group absolute top-0 z-[80] h-full w-2 -translate-x-1/2 cursor-col-resize touch-none focus-visible:outline-none"
      style={{ left: `${position * 100}%` }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0) return;
        const startX = event.clientX;
        const startWidths = [...widths];
        const previousUserSelect = document.body.style.userSelect;
        const previousCursor = document.body.style.cursor;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        const onMove = (moveEvent: PointerEvent) => {
          resizeBy((moveEvent.clientX - startX) / rect.width, rect.width, startWidths);
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
          window.removeEventListener("blur", onUp);
          document.body.style.userSelect = previousUserSelect;
          document.body.style.cursor = previousCursor;
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        window.addEventListener("blur", onUp);
      }}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const containerWidth = containerRef.current?.clientWidth ?? 0;
        const minimum = minimumFor(containerWidth);
        const step = event.shiftKey ? 0.1 : 0.02;
        const delta =
          event.key === "Home"
            ? minimum - currentWidth
            : event.key === "End"
              ? pairTotal - minimum - currentWidth
              : event.key === "ArrowRight"
                ? step
                : -step;
        resizeBy(delta, containerWidth);
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 w-px bg-border transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
      />
    </div>
  );
}

const SplitTaskView = dynamic(
  () => import("@/components/task/TaskView").then((module) => module.TaskView),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted"
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
  const { state, statusFor, reportStatus, dispatch, titleFor, mdUp } = useTaskPanes();
  const pathname = usePathname();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null);
  const [paneWidths, setPaneWidths] = useState<number[]>([]);
  const [gridColumnWidth, setGridColumnWidth] = useState(0.5);
  // 一度開いたタブのみマウントする（初回読み込み・SSE 接続を遅延）。
  // アクティブタブは開封済みに追加、タブが閉じられたら除去して再オープン時に再読み込み。
  const [openedTabs, setOpenedTabs] = useState<Set<string>>(() => new Set());
  const paneLayoutKey = state.panes.map((pane) => pane.id).join("|");
  const paneCount = state.panes.length;

  // ペインの追加・削除時は新しい構成を均等幅から始める。タブ操作では幅を保持する。
  useEffect(() => {
    setPaneWidths(equalPaneWidths(paneCount));
    setGridColumnWidth(0.5);
  }, [paneCount, paneLayoutKey]);

  // dragend/drop でリング解除（Escape キャンセル・ブラウザ外での drop 漏れ対策）
  useEffect(() => {
    const reset = () => setDragOverPaneId(null);
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, []);

  // 開封済みタブ集合の同期: アクティブタブを追加、閉じられたタブを除去。
  // タブ切替の初回のみ読み込みが走り、以降は hidden mount で維持される。
  // reducer は変更時のみ新参照を返すため state を deps にできる。
  useEffect(() => {
    const allTabIds = state.panes.flatMap((pane) => pane.tabs);
    setOpenedTabs((current) => {
      let next = current;
      for (const taskId of allTabIds) {
        if (!next.has(taskId)) {
          next = new Set(next);
          next.add(taskId);
        }
      }
      for (const taskId of current) {
        if (!allTabIds.includes(taskId)) {
          next = new Set(next);
          next.delete(taskId);
        }
      }
      return next;
    });
  }, [state]);

  // task path でのみ render（仕様 §7: Home/settings では非表示、panes state は保持）。
  // splitHostEnabled は Home を含むため描画ゲートには使わない。
  const urlTaskId = taskIdFromPathname(pathname);
  if (!urlTaskId) return null;

  // md 未満: 分割・タブは無効で URL タスクのみ単一表示（仕様 §1 のフォールバック）。
  // モバイルでは Provider の panes/復元を触らず、URL 由来の taskId を直接 render する。
  if (!mdUp) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <SplitTaskView
          key={urlTaskId}
          taskId={urlTaskId}
          onStatus={(status) => reportStatus(urlTaskId, status)}
        />
      </div>
    );
  }

  const activePaneId =
    state.panes.find((pane) => pane.id === state.activePaneId)?.id ?? state.panes[0]?.id ?? null;
  if (!activePaneId) return null;

  const single = state.panes.length === 1 && state.panes[0].tabs.length <= 1;
  const isGrid = state.panes.length >= 4;
  const widths = paneWidths.length === state.panes.length
    ? paneWidths
    : equalPaneWidths(state.panes.length);
  const resizeWidths = isGrid ? [gridColumnWidth, 1 - gridColumnWidth] : widths;
  const handlePositions = isGrid
    ? [gridColumnWidth]
    : widths.slice(0, -1).map((_, index) =>
        widths.slice(0, index + 1).reduce((sum, width) => sum + width, 0),
      );
  const updatePaneWidths = (next: number[]) => {
    if (isGrid) {
      setGridColumnWidth(next[0] ?? 0.5);
    } else {
      setPaneWidths(next);
    }
  };

  return (
    <div
      ref={containerRef}
      className={cx(paneLayoutClass(state), "relative")}
      style={isGrid ? { gridTemplateColumns: `${gridColumnWidth}fr ${1 - gridColumnWidth}fr` } : undefined}
    >
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
          style={!isGrid ? { flex: `${widths[paneIndex] ?? 0} 1 0%` } : undefined}
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
            } else if (pane.tabs.length === 0) {
              // 空ペイン: そのまま開く
              dispatch({ type: "openTab", paneId: pane.id, taskId });
            } else if (!source) {
              // ペイン本体ドロップ = 分割（新ペインで開く）。タブとして追加したい場合はタブバーへ
              dispatch({ type: "openInNewPane", taskId });
            } else {
              dispatch({ type: "activateTab", paneId: pane.id, taskId });
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
              titleFor={titleFor}
              canAddPane={state.panes.length < 4}
              showAddButton={pane.id === state.panes[state.panes.length - 1].id}
              onActivateTab={(taskId) => dispatch({ type: "activateTab", paneId: pane.id, taskId })}
              onCloseTab={(taskId) => dispatch({ type: "closeTab", paneId: pane.id, taskId })}
              onReorderTabs={(tabs) => dispatch({ type: "reorderTabs", paneId: pane.id, tabs })}
              onMoveTab={(taskId, toPaneId) => {
                const source = state.panes.find((p) => p.tabs.includes(taskId));
                if (source && source.id !== toPaneId) {
                  dispatch({ type: "moveTab", fromPaneId: source.id, toPaneId, taskId });
                } else if (!source) {
                  dispatch({ type: "openTab", paneId: toPaneId, taskId });
                }
              }}
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
          {/* 空ペインのガイド（仕様 §6 のドロップ待ち状態） */}
          {pane.tabs.length === 0 && (
            <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-xs text-faint">
              サイドバーからタスクをドロップして開けます
            </div>
          )}
          {pane.tabs.map((taskId) => {
            // 可視性は各ペインの自ペイン内 activeTabId のみで決める。
            // ペインのフォーカス（activePaneId）を条件にすると非アクティブペインが
            // 空描画になる（隣ペインは常に自タブを表示していてこそ分割にならない）。
            const isActiveTab = pane.activeTabId === taskId;
            // 未開封タブはマウントしない（初回読み込み・SSE 接続を遅延）。
            // アクティブタブは開封済み集合へ追加済みなので常にマウントされる。
            if (!openedTabs.has(taskId)) return null;
            return (
              <SplitTaskView
                key={taskId}
                taskId={taskId}
                active={isActiveTab}
                onStatus={(status) => reportStatus(taskId, status)}
                onAddPane={
                  single && state.panes.length < 4
                    ? () => dispatch({ type: "addPane" })
                    : undefined
                }
              />
            );
          })}
        </section>
      ))}
      {!single && handlePositions.map((position, boundaryIndex) => (
        <PaneResizeHandle
          key={`pane-resize-${boundaryIndex}`}
          boundaryIndex={boundaryIndex}
          position={position}
          widths={resizeWidths}
          containerRef={containerRef}
          onResize={updatePaneWidths}
        />
      ))}
    </div>
  );
}
