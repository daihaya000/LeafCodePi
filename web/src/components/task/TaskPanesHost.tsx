"use client";

import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useTaskPanes } from "@/components/shell/TaskPanesContext";
import { cx } from "@/components/ui";
import type { TaskStatus } from "@/lib/types";
import { isTaskDrag, taskDragIdFrom } from "@/lib/task-drag";
import {
  HOME_TAB_ID,
  BOTS_TAB_ID,
  isBotTabId,
  isSplitHostPath,
  paneLayoutForState,
  resizeAdjacentPaneWidths,
  SETTINGS_TAB_ID,
  tabIdFromPathname,
  type PaneLayout,
  type SplitDirection,
  type TaskPane,
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

/** ペイン境界のドラッグハンドル。axis="x" は縦仕切り（左右移動）、y は横仕切り（上下移動）。 */
function PaneResizeHandle({
  boundaryIndex,
  position,
  widths,
  containerRef,
  onResize,
  axis,
  label,
}: {
  boundaryIndex: number;
  position: number;
  widths: readonly number[];
  containerRef: { current: HTMLDivElement | null };
  onResize: (widths: number[]) => void;
  axis: "x" | "y";
  label?: string;
}) {
  const pairTotal = widths[boundaryIndex]! + widths[boundaryIndex + 1]!;
  const currentSize = widths[boundaryIndex]!;
  const sizeLabel = axis === "x" ? "幅" : "高さ";
  const minimumFor = (containerSize: number) =>
    Math.min(MIN_PANE_WIDTH / Math.max(containerSize, MIN_PANE_WIDTH), pairTotal / 2);
  const containerSize =
    axis === "x" ? containerRef.current?.clientWidth ?? 0 : containerRef.current?.clientHeight ?? 0;

  const resizeBy = (delta: number, containerSize: number, startSizes = widths) => {
    onResize(resizeAdjacentPaneWidths(startSizes, boundaryIndex, delta, minimumFor(containerSize)));
  };

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label ?? `ペイン ${boundaryIndex + 1} と ${boundaryIndex + 2} の${sizeLabel}を調整`}
      aria-valuemin={Math.round(minimumFor(containerSize) * 100)}
      aria-valuemax={Math.round((pairTotal - minimumFor(containerSize)) * 100)}
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

const PaneSettingsView = dynamic(
  () => import("@/components/settings/SettingsView").then((module) => module.SettingsView),
  { ssr: false },
);

const PaneBotView = dynamic(
  () => import("@/components/bot/BotView").then((module) => module.BotView),
  { ssr: false },
);
const PaneRoomView = dynamic(
  () => import("@/components/bot/RoomView").then((module) => module.RoomView),
  { ssr: false },
);
const PaneBotListView = dynamic(
  () => import("@/components/bot/BotListView").then((module) => module.BotListView),
  { ssr: false },
);

function BotTabView({ tabId, active = true }: { tabId: string; active?: boolean }) {
  if (tabId === BOTS_TAB_ID) return <PaneBotListView />;
  const room = tabId.startsWith("/bots/rooms/");
  const encoded = tabId.slice(room ? "/bots/rooms/".length : "/bots/".length);
  let id = encoded;
  try { id = decodeURIComponent(encoded); } catch { /* Keep malformed URL readable. */ }
  return room ? <PaneRoomView id={id} active={active} /> : <PaneBotView id={id} active={active} />;
}

type PaneBranchProps = {
  paneById: ReadonlyMap<string, TaskPane>;
  paneIndexes: ReadonlyMap<string, number>;
  activePaneId: string;
  single: boolean;
  dragOverPaneId: string | null;
  dragEdge: { paneId: string; direction: SplitDirection } | null;
  openedTabs: Set<string>;
  projectId: string | null;
  noProject: boolean;
  mdUp: boolean;
  statusFor: (taskId: string) => TaskStatus | null;
  reportStatus: (taskId: string, status: TaskStatus) => void;
  titleFor: (taskId: string) => string | null;
  canAddPane: boolean;
  lastPaneId: string | undefined;
  splitRatios: Record<string, number>;
  onSplitRatioChange: (splitId: string, ratio: number) => void;
  onPaneDragOver: (event: DragEvent<HTMLElement>, pane: TaskPane) => void;
  onPaneDragLeave: (event: DragEvent<HTMLElement>, pane: TaskPane) => void;
  onPaneDrop: (event: DragEvent<HTMLElement>, pane: TaskPane) => void;
  onActivatePane: (paneId: string) => void;
  onActivateTab: (paneId: string, taskId: string) => void;
  onCloseTab: (paneId: string, taskId: string) => void;
  onClearPane: (paneId: string) => void;
  onReorderTabs: (paneId: string, tabs: string[]) => void;
  onMoveTab: (taskId: string, toPaneId: string) => void;
  onAddPane: () => void;
  onOpenHome: (paneId: string) => void;
};

function paneIdsInLayout(layout: PaneLayout): string[] {
  return layout.type === "pane"
    ? [layout.paneId]
    : [...paneIdsInLayout(layout.children[0]), ...paneIdsInLayout(layout.children[1])];
}

function paneRangeLabel(layout: PaneLayout, paneIndexes: ReadonlyMap<string, number>): string {
  const indexes = paneIdsInLayout(layout)
    .map((paneId) => paneIndexes.get(paneId))
    .filter((index): index is number => index !== undefined)
    .sort((a, b) => a - b)
    .map((index) => index + 1);
  if (indexes.length === 0) return "ペイン";
  const first = indexes[0]!;
  const last = indexes[indexes.length - 1]!;
  return first === last ? `ペイン ${first}` : `ペイン ${first}〜${last}`;
}

function PaneSection({
  pane,
  paneIndex,
  activePaneId,
  single,
  dragOverPaneId,
  dragEdge,
  openedTabs,
  projectId,
  noProject,
  mdUp,
  statusFor,
  reportStatus,
  titleFor,
  canAddPane,
  lastPaneId,
  onPaneDragOver,
  onPaneDragLeave,
  onPaneDrop,
  onActivatePane,
  onActivateTab,
  onCloseTab,
  onClearPane,
  onReorderTabs,
  onMoveTab,
  onAddPane,
  onOpenHome,
}: PaneBranchProps & { pane: TaskPane; paneIndex: number }) {
  const isActivePane = pane.id === activePaneId;
  return (
    <section
      data-pane-id={pane.id}
      data-active={isActivePane ? "true" : "false"}
      aria-label={`タスクペイン ${paneIndex + 1}`}
      className={cx(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        !single && "border-border",
        dragOverPaneId === pane.id && dragEdge?.paneId !== pane.id &&
          "ring-1 ring-inset ring-accent/50",
      )}
      onDragOver={(event) => onPaneDragOver(event, pane)}
      onDragLeave={(event) => onPaneDragLeave(event, pane)}
      onDrop={(event) => onPaneDrop(event, pane)}
      onPointerDown={() => {
        if (!isActivePane) onActivatePane(pane.id);
      }}
      onFocusCapture={() => {
        if (!isActivePane) onActivatePane(pane.id);
      }}
    >
      {!single && (
        <TaskTabs
          pane={pane}
          isActivePane={isActivePane}
          statusFor={statusFor}
          titleFor={titleFor}
          canAddPane={canAddPane}
          showAddButton={pane.id === lastPaneId}
          onActivateTab={(taskId) => onActivateTab(pane.id, taskId)}
          onCloseTab={(taskId) => onCloseTab(pane.id, taskId)}
          onClearPane={() => onClearPane(pane.id)}
          onReorderTabs={(tabs) => onReorderTabs(pane.id, tabs)}
          onMoveTab={onMoveTab}
          onAddPane={onAddPane}
          onOpenHome={() => onOpenHome(pane.id)}
        />
      )}
      {isActivePane && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-[70] h-0.5 bg-accent"
        />
      )}
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
      {pane.tabs.length === 0 && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-xs text-faint">
          サイドバーからタスクをドロップして開けます
        </div>
      )}
      {pane.tabs.map((taskId) => {
        const isActiveTab = pane.activeTabId === taskId;
        if (!openedTabs.has(taskId)) return null;
        if (isBotTabId(taskId)) {
          return (
            <div key={taskId} className={cx("flex min-h-0 min-w-0 flex-1 flex-col", !isActiveTab && "hidden")}>
              <BotTabView tabId={taskId} active={isActiveTab} />
            </div>
          );
        }
        if (taskId === HOME_TAB_ID) {
          return (
            <div
              key={taskId}
              className={cx("min-h-0 min-w-0 flex-1", !isActiveTab && "hidden")}
            >
              <PaneHomeView
                key={`${projectId ?? ""}:${noProject ? "no-project" : "project"}`}
                initialProjectId={projectId ?? undefined}
                initialNoProject={noProject}
              />
            </div>
          );
        }
        if (taskId === SETTINGS_TAB_ID) {
          return (
            <div
              key={taskId}
              className={cx("min-h-0 min-w-0 flex-1", !isActiveTab && "hidden")}
            >
              <PaneSettingsView />
            </div>
          );
        }
        return (
          <div
            key={taskId}
            className={cx("flex min-h-0 min-w-0 flex-1 flex-col", !isActiveTab && "hidden")}
          >
            <SplitTaskView
              taskId={taskId}
              mdUp={mdUp}
              active={isActiveTab}
              onStatus={reportStatus}
              onAddPane={single && canAddPane ? onAddPane : undefined}
            />
          </div>
        );
      })}
    </section>
  );
}

function PaneLayoutBranch({ layout, ...props }: PaneBranchProps & { layout: PaneLayout }) {
  const containerRef = useRef<HTMLDivElement>(null);
  if (layout.type === "pane") {
    const pane = props.paneById.get(layout.paneId);
    if (!pane) return null;
    return (
      <PaneSection
        {...props}
        pane={pane}
        paneIndex={props.paneIndexes.get(pane.id) ?? 0}
      />
    );
  }

  const firstPaneCount = paneIdsInLayout(layout.children[0]).length;
  const totalPaneCount = firstPaneCount + paneIdsInLayout(layout.children[1]).length;
  const defaultRatio = firstPaneCount / totalPaneCount;
  const ratio = Math.max(0.05, Math.min(0.95, props.splitRatios[layout.id] ?? defaultRatio));
  const axis = layout.orientation === "row" ? "x" : "y";
  const sizeLabel = axis === "x" ? "幅" : "高さ";
  return (
    <div
      ref={containerRef}
      className={cx(
        "relative flex min-h-0 min-w-0 flex-1 overflow-hidden",
        layout.orientation === "column" && "flex-col",
      )}
    >
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        style={{ flex: `${ratio} 1 0%` }}
      >
        <PaneLayoutBranch {...props} layout={layout.children[0]} />
      </div>
      <PaneResizeHandle
        boundaryIndex={0}
        position={ratio}
        widths={[ratio, 1 - ratio]}
        containerRef={containerRef}
        onResize={(next) => props.onSplitRatioChange(layout.id, next[0] ?? ratio)}
        axis={axis}
        label={`${paneRangeLabel(layout.children[0], props.paneIndexes)} と ${paneRangeLabel(layout.children[1], props.paneIndexes)} の${sizeLabel}を調整`}
      />
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        style={{ flex: `${1 - ratio} 1 0%` }}
      >
        <PaneLayoutBranch {...props} layout={layout.children[1]} />
      </div>
    </div>
  );
}

/**
 * 分割ホスト対象パス（「/」＝新規作成タブ含む）で内容を返す描画ホスト。
 * Home / settings も特殊タブとしてタスクと同じくペイン内にマウントする。
 * 非アクティブなタブも hidden mount で状態を保持する。
 *
 * hidden mount（仕様 §4）: 各ペイン内の全タブの TaskView を render し、
 * 非アクティブは CSS hidden。key={taskId} でインスタンスと SSE を維持する。
 * 1 ペイン × 1 タブではタブバーを表示しない（仕様 §1 の従来通り）。
 */
export function TaskPanesHost() {
  const { state, statusFor, reportStatus, dispatch, retargetToUrl, activeTaskId, titleFor, mdUp } = useTaskPanes();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId");
  const noProject = searchParams.get("noProject") === "1";
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null);
  // 端ドラッグ中の分割プレビュー。null = 中央（通常ドロップ）。
  const [dragEdge, setDragEdge] = useState<{ paneId: string; direction: SplitDirection } | null>(
    null,
  );
  // 各 split node の比率。ペイン構成が変わったときだけ初期化する。
  const [splitRatios, setSplitRatios] = useState<Record<string, number>>({});
  // 一度開いたタブのみマウントする（初回読み込み・SSE 接続を遅延）。
  // アクティブタブは開封済み集合へ追加、タブが閉じられたら除去して再オープン時に再読み込み。
  const [openedTabs, setOpenedTabs] = useState<Set<string>>(() => new Set());
  const addPane = useCallback(() => dispatch({ type: "addPane" }), [dispatch]);
  const paneLayoutKey = state.panes.map((pane) => pane.id).join("|");

  useEffect(() => {
    setSplitRatios({});
  }, [paneLayoutKey]);

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
    const activeTabIds = state.panes.flatMap((pane) =>
      pane.activeTabId && pane.tabs.includes(pane.activeTabId) ? [pane.activeTabId] : [],
    );
    setOpenedTabs((current) => {
      let next = current;
      for (const taskId of activeTabIds) {
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
    if (
      pathname !== "/" ||
      (projectId === null && !noProject) ||
      !mdUp ||
      activeTaskId === HOME_TAB_ID
    ) return;
    retargetToUrl(HOME_TAB_ID);
  }, [activeTaskId, mdUp, noProject, pathname, projectId, retargetToUrl]);

  // 分割ホスト対象パス（「/」・task・settings）でのみ render。
  const urlTabId = tabIdFromPathname(pathname);
  if (!isSplitHostPath(pathname)) return null;

  // md 未満: 分割・タブは無効で URL タスクまたは設定画面を単一表示。
  // モバイルでは Provider の panes/復元を触らず、URL 由来の内容を直接 render する。
  // 「/」では Host を出さず page の HomeView（children）へ任せる。
  if (!mdUp) {
    if (isBotTabId(urlTabId)) return <BotTabView key={urlTabId} tabId={urlTabId!} />;
    if (pathname === "/settings") {
      return (
        <div className="flex min-h-0 min-w-0 flex-1">
          <PaneSettingsView />
        </div>
      );
    }
    if (!urlTabId) return null;
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <SplitTaskView
          key={urlTabId}
          taskId={urlTabId}
          mdUp={mdUp}
          onStatus={reportStatus}
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
    state.panes[0].tabs[0] !== HOME_TAB_ID &&
    state.panes[0].tabs[0] !== SETTINGS_TAB_ID &&
    !isBotTabId(state.panes[0].tabs[0]);
  const layout = paneLayoutForState(state);
  if (!layout) return null;
  const paneById = new Map(state.panes.map((pane) => [pane.id, pane]));
  const paneIndexes = new Map(state.panes.map((pane, index) => [pane.id, index]));
  const lastPaneId = state.panes[state.panes.length - 1]?.id;
  const canAddPane = state.panes.length < 4;
  const updateSplitRatio = (splitId: string, ratio: number) => {
    if (!Number.isFinite(ratio)) return;
    const nextRatio = Math.max(0.05, Math.min(0.95, ratio));
    setSplitRatios((current) => {
      if (current[splitId] === nextRatio) return current;
      return { ...current, [splitId]: nextRatio };
    });
  };
  const onPaneDragOver = (event: DragEvent<HTMLElement>, pane: TaskPane) => {
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
  };
  const onPaneDragLeave = (event: DragEvent<HTMLElement>, pane: TaskPane) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOverPaneId((current) => (current === pane.id ? null : current));
    setDragEdge((current) => (current?.paneId === pane.id ? null : current));
  };
  const onPaneDrop = (event: DragEvent<HTMLElement>, pane: TaskPane) => {
    if (!isTaskDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragOverPaneId(null);
    setDragEdge(null);
    const taskId = taskDragIdFrom(event.dataTransfer);
    if (!taskId) return;
    const source = state.panes.find((candidate) => candidate.tabs.includes(taskId));
    const direction = edgeDirectionAt(event.currentTarget, event.clientX, event.clientY);
    if (direction) {
      // 端ドロップ = anchor ペインだけを方向分割する。
      dispatch({ type: "openInNewPane", taskId, anchorPaneId: pane.id, direction });
    } else if (source && source.id !== pane.id) {
      dispatch({ type: "moveTab", fromPaneId: source.id, toPaneId: pane.id, taskId });
    } else if (pane.tabs.length === 0) {
      dispatch({ type: "openTab", paneId: pane.id, taskId });
    } else if (!source) {
      // ペイン本体ドロップ = 分割。タブとして追加したい場合はタブバーへ。
      dispatch({ type: "openInNewPane", taskId });
    } else {
      dispatch({ type: "activateTab", paneId: pane.id, taskId });
    }
  };
  const onMoveTab = (taskId: string, toPaneId: string) => {
    const source = state.panes.find((pane) => pane.tabs.includes(taskId));
    if (source && source.id !== toPaneId) {
      dispatch({ type: "moveTab", fromPaneId: source.id, toPaneId, taskId });
    } else if (!source) {
      dispatch({ type: "openTab", paneId: toPaneId, taskId });
    }
  };

  return (
    <div className={cx(paneLayoutClass(state), "relative")}>
      <PaneLayoutBranch
        layout={layout}
        paneById={paneById}
        paneIndexes={paneIndexes}
        activePaneId={activePaneId}
        single={single}
        dragOverPaneId={dragOverPaneId}
        dragEdge={dragEdge}
        openedTabs={openedTabs}
        projectId={projectId}
        noProject={noProject}
        mdUp={mdUp}
        statusFor={statusFor}
        reportStatus={reportStatus}
        titleFor={titleFor}
        canAddPane={canAddPane}
        lastPaneId={lastPaneId}
        splitRatios={splitRatios}
        onSplitRatioChange={updateSplitRatio}
        onPaneDragOver={onPaneDragOver}
        onPaneDragLeave={onPaneDragLeave}
        onPaneDrop={onPaneDrop}
        onActivatePane={(paneId) => dispatch({ type: "activatePane", paneId })}
        onActivateTab={(paneId, taskId) => dispatch({ type: "activateTab", paneId, taskId })}
        onCloseTab={(paneId, taskId) => dispatch({ type: "closeTab", paneId, taskId })}
        onClearPane={(paneId) => {
          const pane = state.panes.find((candidate) => candidate.id === paneId);
          const keepTabIds = pane?.tabs.filter((taskId) => statusFor(taskId) === "working");
          dispatch({ type: "clearPane", paneId, keepTabIds });
        }}
        onReorderTabs={(paneId, tabs) => dispatch({ type: "reorderTabs", paneId, tabs })}
        onMoveTab={onMoveTab}
        onAddPane={addPane}
        onOpenHome={(paneId) => dispatch({ type: "openTab", paneId, taskId: isBotTabId(activeTaskId) ? BOTS_TAB_ID : HOME_TAB_ID })}
      />
    </div>
  );
}
