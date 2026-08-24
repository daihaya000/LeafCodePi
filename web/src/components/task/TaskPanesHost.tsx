"use client";

import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTaskPanes } from "@/components/shell/TaskPanesContext";
import { cx } from "@/components/ui";
import { isTaskDrag, taskDragIdFrom } from "@/lib/task-drag";
import {
  HOME_TAB_ID,
  isSplitHostPath,
  resizeAdjacentPaneWidths,
  taskIdFromPathname,
  type SplitDirection,
} from "@/lib/task-panes";
import { paneLayoutClass, TaskTabs } from "./TaskTabs";

const MIN_PANE_WIDTH = 240;

/**
 * 要素矩形の端（25% 以内）へのドラッグ座標から分割方向を返す。
 * 中央寄りは null = 従来どおりのペイン内ドロップ扱い。
 */
function edgeDirectionAt(
  element: Element,
  clientX: number,
  clientY: number,
): SplitDirection | null {
  const rect = element.getBoundingClientRect();
  const distances: readonly [SplitDirection, number][] = [
    ["left", clientX - rect.left],
    ["right", rect.right - clientX],
    ["top", clientY - rect.top],
    ["bottom", rect.bottom - clientY],
  ];
  const nearest = Math.min(...distances.map(([, distance]) => distance));
  if (nearest < 0 || nearest > Math.min(rect.width, rect.height) * 0.25) return null;
  return distances.find(([, distance]) => distance === nearest)?.[0] ?? null;
}

function equalPaneWidths(count: number): number[] {
  return count > 0 ? Array.from({ length: count }, () => 1 / count) : [];
}

/** ペイン境界のドラッグハンドル。axis="x" は縦仕切り（左右移動）、y は横仕切り（上下移動）。 */
function PaneResizeHandle({
  boundaryIndex,
  position,
  widths,
  containerRef,
  onResize,
  axis,
}: {
  boundaryIndex: number;
  position: number;
  widths: readonly number[];
  containerRef: { current: HTMLDivElement | null };
  onResize: (widths: number[]) => void;
  axis: "x" | "y";
}) {
  const pairTotal = widths[boundaryIndex]! + widths[boundaryIndex + 1]!;
  const currentSize = widths[boundaryIndex]!;
  const sizeLabel = axis === "x" ? "幅" : "高さ";
  const minimumFor = (containerSize: number) =>
    Math.min(MIN_PANE_WIDTH / Math.max(containerSize, MIN_PANE_WIDTH), pairTotal / 2);

  const resizeBy = (delta: number, containerSize: number, startSizes = widths) => {
    onResize(resizeAdjacentPaneWidths(startSizes, boundaryIndex, delta, minimumFor(containerSize)));
  };

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={`ペイン ${boundaryIndex + 1} と ${boundaryIndex + 2} の${sizeLabel}を調整`}
      aria-valuemin={Math.round(minimumFor(containerRef.current?.clientWidth ?? 0) * 100)}
      aria-valuemax={Math.round((pairTotal - minimumFor(containerRef.current?.clientWidth ?? 0)) * 100)}
      aria-valuenow={Math.round(currentSize * 100)}
      tabIndex={0}
      className={cx(
        "group absolute z-[80] touch-none focus-visible:outline-none",
        axis === "x"
          ? "top-0 h-full w-2 -translate-x-1/2 cursor-col-resize"
          : "left-0 w-full h-2 -translate-y-1/2 cursor-row-resize",
      )}
      style={axis === "x" ? { left: `${position * 100}%` } : { top: `${position * 100}%` }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const containerSize = axis === "x" ? rect.width : rect.height;
        const startPos = axis === "x" ? event.clientX : event.clientY;
        const startSizes = [...widths];
        const previousUserSelect = document.body.style.userSelect;
        const previousCursor = document.body.style.cursor;
        document.body.style.userSelect = "none";
        document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
        const onMove = (moveEvent: PointerEvent) => {
          const moved =
            (axis === "x" ? moveEvent.clientX : moveEvent.clientY) - startPos;
          resizeBy(moved / containerSize, containerSize, startSizes);
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
        const backKey = axis === "x" ? "ArrowLeft" : "ArrowUp";
        const forwardKey = axis === "x" ? "ArrowRight" : "ArrowDown";
        if (![backKey, forwardKey, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const containerSize =
          (axis === "x"
            ? containerRef.current?.clientWidth
            : containerRef.current?.clientHeight) ?? 0;
        const minimum = minimumFor(containerSize);
        const step = event.shiftKey ? 0.1 : 0.02;
        const delta =
          event.key === "Home"
            ? minimum - currentSize
            : event.key === "End"
              ? pairTotal - minimum - currentSize
              : event.key === forwardKey
                ? step
                : -step;
        resizeBy(delta, containerSize);
      }}
    >
      <span
        aria-hidden="true"
        className={
          axis === "x"
            ? "absolute inset-y-0 left-1/2 w-px bg-border transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
            : "absolute inset-x-0 top-1/2 h-px bg-border transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
        }
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

const PaneHomeView = dynamic(
  () => import("@/components/home/HomeView").then((module) => module.HomeView),
  { ssr: false },
);

/**
 * 分割ホスト対象パス（「/」＝新規作成タブ含む）で内容を返す描画ホスト。
 * settings では null を返すだけで Provider の panes state・SSE は保持される
 * （仕様 §7 の panes 保持方式）。Home タブは特殊 ID HOME_TAB_ID として
 * タスクと同じくペイン内に HomeView をマウントする。
 *
 * hidden mount（仕様 §4）: 各ペイン内の全タブの TaskView を render し、
 * 非アクティブは CSS hidden。key={taskId} でインスタンスと SSE を維持する。
 * 1 ペイン × 1 タブではタブバーを表示しない（仕様 §1 の従来通り）。
 */
export function TaskPanesHost() {
  const { state, statusFor, reportStatus, dispatch, retargetToUrl, activeTaskId, titleFor, mdUp } = useTaskPanes();
  const pathname = usePathname();
  const projectId = useSearchParams().get("projectId");
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null);
  // 端ドラッグ中の分割プレビュー。null = 中央（通常ドロップ）。
  const [dragEdge, setDragEdge] = useState<{ paneId: string; direction: SplitDirection } | null>(
    null,
  );
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
    const reset = () => {
      setDragOverPaneId(null);
      setDragEdge(null);
    };
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

  // プロジェクト指定付きのホーム遷移は pathname が変わらない場合もあるため、
  // クエリを検知したら新規作成（Home）タブへ切り替える。
  useEffect(() => {
    if (pathname !== "/" || projectId === null || !mdUp || activeTaskId === HOME_TAB_ID) return;
    retargetToUrl(HOME_TAB_ID);
  }, [activeTaskId, mdUp, pathname, projectId, retargetToUrl]);

  // 分割ホスト対象パス（「/」と task path）でのみ render。settings では非表示。
  const urlTaskId = taskIdFromPathname(pathname);
  if (!isSplitHostPath(pathname)) return null;

  // md 未満: 分割・タブは無効で URL タスクのみ単一表示（仕様 §1 のフォールバック）。
  // モバイルでは Provider の panes/復元を触らず、URL 由来の taskId を直接 render する。
  // 「/」では Host を出さず page の HomeView（children）へ任せる。
  if (!mdUp) {
    if (!urlTaskId) return null;
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

  // Home タブだけの単一ペインでもタブバーを出す（+ でタスクを新規作成する入口のため）。
  const single =
    state.panes.length === 1 &&
    state.panes[0].tabs.length <= 1 &&
    state.panes[0].tabs[0] !== HOME_TAB_ID;
  const isGrid = state.panes.length >= 4;
  const isColumn = !isGrid && state.orientation === "column";
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
      style={
        isGrid
          ? { gridTemplateColumns: `${gridColumnWidth}fr ${1 - gridColumnWidth}fr` }
          : undefined
      }
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
            // 横並び: 左隣との境界 / 縦並び: 上隣との境界 / grid: 右列・下段に罫線
            !single && !isGrid && paneIndex > 0 && (isColumn ? "border-t" : "border-l"),
            !single && isGrid && paneIndex % 2 === 1 && "border-l",
            !single && isGrid && paneIndex >= 2 && "border-t",
            dragOverPaneId === pane.id &&
              dragEdge?.paneId !== pane.id &&
              "ring-1 ring-inset ring-accent/50",
          )}
          style={!isGrid ? { flex: `${widths[paneIndex] ?? 0} 1 0%` } : undefined}
          onDragOver={(event) => {
            if (!isTaskDrag(event.dataTransfer.types)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDragOverPaneId(pane.id);
            const direction = edgeDirectionAt(event.currentTarget, event.clientX, event.clientY);
            setDragEdge((current) =>
              current?.paneId === pane.id && current.direction === direction
                ? current
                : direction
                  ? { paneId: pane.id, direction }
                  : null,
            );
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragOverPaneId((current) => (current === pane.id ? null : current));
            setDragEdge((current) => (current?.paneId === pane.id ? null : current));
          }}
          onDrop={(event) => {
            if (!isTaskDrag(event.dataTransfer.types)) return;
            event.preventDefault();
            event.stopPropagation();
            setDragOverPaneId(null);
            setDragEdge(null);
            const taskId = taskDragIdFrom(event.dataTransfer);
            if (!taskId) return;
            const source = state.panes.find((p) => p.tabs.includes(taskId));
            const direction = edgeDirectionAt(event.currentTarget, event.clientX, event.clientY);
            if (direction) {
              // 端ドロップ = Blender/Cursor 方式の方向分割。既存タスクは元ペインから外れて新ペインへ移動する。
              dispatch({ type: "openInNewPane", taskId, anchorPaneId: pane.id, direction });
            } else if (source && source.id !== pane.id) {
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
              onOpenHome={() => dispatch({ type: "openTab", paneId: pane.id, taskId: HOME_TAB_ID })}
            />
          )}
          {/* アクティブペインのアクセント線（仕様 §6） */}
          {pane.id === activePaneId && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-[70] h-0.5 bg-accent"
            />
          )}
          {/* 端ドラッグ中の分割プレビュー（VS Code 風に分割後の占有領域を半分で示す） */}
          {dragEdge?.paneId === pane.id && (
            <span
              aria-hidden="true"
              className={cx(
                "pointer-events-none absolute z-[75] bg-accent/15 ring-1 ring-inset ring-accent/40",
                dragEdge.direction === "left" && "inset-y-0 left-0 w-1/2",
                dragEdge.direction === "right" && "inset-y-0 right-0 w-1/2",
                dragEdge.direction === "top" && "inset-x-0 top-0 h-1/2",
                dragEdge.direction === "bottom" && "inset-x-0 bottom-0 h-1/2",
              )}
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
            // 新規作成（Home）タブ: TaskView の代わりに HomeView を同じ隠しマウント方式で載せる
            if (taskId === HOME_TAB_ID) {
              return (
                <div
                  key={taskId}
                  className={cx("min-h-0 min-w-0 flex-1", !isActiveTab && "hidden")}
                >
                  <PaneHomeView initialProjectId={projectId ?? undefined} />
                </div>
              );
            }
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
          axis={isGrid || !isColumn ? "x" : "y"}
        />
      ))}
    </div>
  );
}
