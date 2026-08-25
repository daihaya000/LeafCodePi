/**
 * TaskView タブ・ペイン model。React に依存しない純関数のみ。
 * 設計: docs/specs/taskview-tabs.md §1〜§5、docs/plans/taskview-tabs-implementation.md Phase 1
 *
 * 不変条件:
 * - panes は最小 1 / 最大 MAX_PANES
 * - 各ペインのタブは最大 MAX_TABS_PER_PANE、同一ペイン内に重複なし
 * - 上限超過・不正操作は前状態を**同一参照**のまま返す no-op（prev === next で拒否を検知可）
 */

export const MAX_PANES = 4;
export const MAX_TABS_PER_PANE = 5;
export const TASK_PANES_STORAGE_KEY = "webui:task-panes";
/** 新規作成（HomeView）を表す特殊タブID。タスク ID 空間と衝突しない固定値。 */
export const HOME_TAB_ID = "home";

export type TaskPane = {
  id: string;
  tabs: string[];
  activeTabId: string | null;
};

/** ペインの並び方向。省略は "row"（横並び）。上下分割で "column" になる。 */
export type PaneOrientation = "row" | "column";

/** 端ドラッグ分割の方向。left/top は anchor の前、right/bottom は後ろへ挿入。 */
export type SplitDirection = "left" | "right" | "top" | "bottom";

export type TaskPanesState = {
  panes: TaskPane[];
  activePaneId: string | null;
  orientation?: PaneOrientation;
};

/** 隣接する 2 ペインの幅を、指定した最小幅を保って調整する。 */
export function resizeAdjacentPaneWidths(
  widths: readonly number[],
  boundaryIndex: number,
  delta: number,
  minWidth: number,
): number[] {
  const rightIndex = boundaryIndex + 1;
  if (
    !Number.isFinite(delta) ||
    !Number.isFinite(minWidth) ||
    boundaryIndex < 0 ||
    rightIndex >= widths.length
  ) {
    return [...widths];
  }
  const pairTotal = widths[boundaryIndex]! + widths[rightIndex]!;
  const minimum = Math.max(0, Math.min(minWidth, pairTotal / 2));
  const leftWidth = Math.max(
    minimum,
    Math.min(pairTotal - minimum, widths[boundaryIndex]! + delta),
  );
  const next = [...widths];
  next[boundaryIndex] = leftWidth;
  next[rightIndex] = pairTotal - leftWidth;
  return next;
}

export type TaskPanesAction =
  | { type: "openTab"; paneId: string; taskId: string }
  | {
      type: "openInNewPane";
      taskId: string;
      /** 分割基準ペイン。省略時は末尾へ追加。 */
      anchorPaneId?: string;
      /** 分割方向。指定時は並び方向も更新する（left/right→row、top/bottom→column）。 */
      direction?: SplitDirection;
    }
  | { type: "closeTab"; paneId: string; taskId: string }
  | { type: "activateTab"; paneId: string; taskId: string }
  | { type: "reorderTabs"; paneId: string; tabs: string[] }
  | {
      type: "moveTab";
      fromPaneId: string;
      toPaneId: string;
      taskId: string;
      index?: number;
    }
  | { type: "addPane" }
  | { type: "closePane"; paneId: string }
  | { type: "activatePane"; paneId: string }
  | { type: "replace"; state: TaskPanesState };

/** UI ローカル ID。http（非 secure context）でも動くよう自前生成。 */
export function createPane(): TaskPane {
  const id = `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, tabs: [], activeTabId: null };
}

/**
 * 初期状態。URL 直リンクの taskId を最初のタブにし、なければ
 * 新規作成（Home）タブをアクティブにする（仕様 §5）。
 */
export function createState(urlTaskId?: string | null): TaskPanesState {
  const pane = createPane();
  pane.tabs = [urlTaskId ?? HOME_TAB_ID];
  pane.activeTabId = urlTaskId ?? HOME_TAB_ID;
  return { panes: [pane], activePaneId: pane.id };
}

function activate(
  state: TaskPanesState,
  paneId: string,
  taskId: string,
): TaskPanesState {
  const target = state.panes.find((pane) => pane.id === paneId);
  if (!target || !target.tabs.includes(taskId)) return state;
  return {
    ...state,
    activePaneId: paneId,
    panes: state.panes.map((pane) =>
      pane.id === paneId ? { ...pane, activeTabId: taskId } : pane,
    ),
  };
}

function removePane(state: TaskPanesState, paneId: string): TaskPanesState {
  if (state.panes.length <= 1) return state; // 最小 1 ペイン制約
  const index = state.panes.findIndex((pane) => pane.id === paneId);
  if (index < 0) return state;
  const panes = state.panes.filter((pane) => pane.id !== paneId);
  // 繰り上げ規則: 閉じた位置の右隣、端なら左隣（panes.length ≥ 1 は制約で保証）
  return {
    ...state,
    panes,
    activePaneId:
      state.activePaneId === paneId
        ? (panes[Math.min(index, panes.length - 1)]?.id ?? null)
        : state.activePaneId,
  };
}

function applyReorder(
  state: TaskPanesState,
  paneId: string,
  tabs: string[],
): TaskPanesState {
  const target = state.panes.find((pane) => pane.id === paneId);
  if (!target) return state;
  // 同一集合のみ許容（長さ・重複なし・全要素一致）
  if (
    tabs.length !== target.tabs.length ||
    new Set(tabs).size !== tabs.length ||
    !tabs.every((id) => target.tabs.includes(id))
  ) {
    return state;
  }
  return {
    ...state,
    panes: state.panes.map((pane) =>
      pane.id === paneId ? { ...pane, tabs: [...tabs] } : pane,
    ),
  };
}

function insertAt(list: string[], value: string, index: number): string[] {
  const at = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), value, ...list.slice(at)];
}

export function taskPanesReducer(
  state: TaskPanesState,
  action: TaskPanesAction,
): TaskPanesState {
  switch (action.type) {
    case "replace":
      return normalize(action.state) ?? state;

    case "openTab": {
      // 重複時は既存タブの活性化に寄せる（同一タスクを複数タブにしない）
      const existing = state.panes.find((pane) => pane.tabs.includes(action.taskId));
      if (existing) return activate(state, existing.id, action.taskId);
      const target = state.panes.find((pane) => pane.id === action.paneId);
      if (!target || target.tabs.length >= MAX_TABS_PER_PANE) return state;
      return {
        activePaneId: target.id,
        panes: state.panes.map((pane) =>
          pane.id === target.id
            ? { ...pane, tabs: [...pane.tabs, action.taskId], activeTabId: action.taskId }
            : pane,
        ),
      };
    }

    case "openInNewPane": {
      // ペイン本体へのドロップ = 分割の意図。新ペインでタスクを開く。
      // direction 指定時は anchor の前後に挿入（Blender/Cursor 方式の端分割）。
      // 上限到達時は最後のペインのタブへフォールバック。
      const existing = state.panes.find((pane) => pane.tabs.includes(action.taskId));
      let panes = state.panes;
      if (existing) {
        // 単独タブのペインなら移動しても見た目が同じため活性化のみ
        if (existing.tabs.length === 1 && !action.direction) {
          return activate(state, existing.id, action.taskId);
        }
        const fromIndex = existing.tabs.indexOf(action.taskId);
        const fromTabs = existing.tabs.filter((id) => id !== action.taskId);
        const nextActive =
          existing.activeTabId !== action.taskId
            ? existing.activeTabId
            : (fromTabs[Math.min(fromIndex, fromTabs.length - 1)] ?? null);
        panes = panes.map((pane) =>
          pane.id === existing.id ? { ...pane, tabs: fromTabs, activeTabId: nextActive } : pane,
        );
      }
      if (panes.length >= MAX_PANES) {
        const last = panes[panes.length - 1]!;
        return taskPanesReducer(
          { ...state, panes },
          { type: "openTab", paneId: last.id, taskId: action.taskId },
        );
      }
      const anchorIndex = action.anchorPaneId
        ? panes.findIndex((pane) => pane.id === action.anchorPaneId)
        : -1;
      const insertIndex =
        anchorIndex < 0 || !action.direction
          ? panes.length
          : action.direction === "left" || action.direction === "top"
            ? anchorIndex
            : anchorIndex + 1;
      const orientation =
        action.direction === "top" || action.direction === "bottom"
          ? "column"
          : action.direction === "left" || action.direction === "right"
            ? ("row" as const)
            : (state.orientation ?? "row");
      const pane = createPane();
      return {
        activePaneId: pane.id,
        orientation,
        panes: [
          ...panes.slice(0, insertIndex),
          { ...pane, tabs: [action.taskId], activeTabId: action.taskId },
          ...panes.slice(insertIndex),
        ],
      };
    }

    case "closeTab": {
      const target = state.panes.find((pane) => pane.id === action.paneId);
      const tabIndex = target?.tabs.indexOf(action.taskId) ?? -1;
      if (!target || tabIndex < 0) return state;
      // 最終タブを閉じたらペインごと閉じる。ただし最小 1 ペイン制約で最後のペインは残す
      if (target.tabs.length === 1) {
        return removePane(state, target.id);
      }
      const nextTabs = target.tabs.filter((id) => id !== action.taskId);
      const nextActive =
        target.activeTabId !== action.taskId
          ? target.activeTabId
          : (nextTabs[Math.min(tabIndex, nextTabs.length - 1)] ?? null);
      return {
        ...state,
        panes: state.panes.map((pane) =>
          pane.id === target.id ? { ...pane, tabs: nextTabs, activeTabId: nextActive } : pane,
        ),
      };
    }

    case "activateTab":
      return activate(state, action.paneId, action.taskId);

    case "reorderTabs":
      return applyReorder(state, action.paneId, action.tabs);

    case "moveTab": {
      const from = state.panes.find((pane) => pane.id === action.fromPaneId);
      const to = state.panes.find((pane) => pane.id === action.toPaneId);
      if (!from || !to || !from.tabs.includes(action.taskId)) return state;
      if (from.id === to.id) {
        const without = from.tabs.filter((id) => id !== action.taskId);
        return applyReorder(
          state,
          from.id,
          insertAt(without, action.taskId, action.index ?? without.length),
        );
      }
      if (to.tabs.length >= MAX_TABS_PER_PANE) return state;
      const fromIndex = from.tabs.indexOf(action.taskId);
      const fromTabs = from.tabs.filter((id) => id !== action.taskId);
      const nextFromActive =
        from.activeTabId !== action.taskId
          ? from.activeTabId
          : (fromTabs[Math.min(fromIndex, fromTabs.length - 1)] ?? null);
      return {
        ...state,
        activePaneId: to.id, // 移動したタブを見せる（本家 openSplit と同じ）
        panes: state.panes.map((pane) => {
          if (pane.id === from.id) {
            return { ...pane, tabs: fromTabs, activeTabId: nextFromActive };
          }
          if (pane.id === to.id) {
            return {
              ...pane,
              tabs: insertAt(to.tabs, action.taskId, action.index ?? to.tabs.length),
              activeTabId: action.taskId,
            };
          }
          return pane;
        }),
      };
    }

    case "addPane": {
      if (state.panes.length >= MAX_PANES) return state;
      const pane = createPane();
      return { ...state, panes: [...state.panes, pane], activePaneId: pane.id };
    }

    case "closePane":
      return removePane(state, action.paneId);

    case "activatePane": {
      if (!state.panes.some((pane) => pane.id === action.paneId)) return state;
      return state.activePaneId === action.paneId
        ? state
        : { ...state, activePaneId: action.paneId };
    }
  }
}

/**
 * 指定 taskId を全ペインのタブから除去する（タスク削除時の自動クローズ、仕様 §4）。
 * 各ペインで closeTab 相当の挙動（activeTabId 繰り上げ・空きペインの縮退）を
 * 適用した新 state を返す。対象タブがなければ同一参照を返す。
 * 最終ペインの最終タブでも除去し、URL タスク消失に備えて空タブのペインへ
 * 縮退させる（removePane の「最小 1 ペイン」制約は削除クローズでは適用しない）。
 */
export function removeTaskEverywhere(
  state: TaskPanesState,
  taskId: string,
): TaskPanesState {
  if (!state.panes.some((pane) => pane.tabs.includes(taskId))) return state;
  let nextPanes = state.panes;
  let nextActivePaneId = state.activePaneId;
  for (const pane of state.panes) {
    if (!pane.tabs.includes(taskId)) continue;
    const nextTabs = pane.tabs.filter((id) => id !== taskId);
    if (nextTabs.length > 0) {
      const tabIndex = pane.tabs.indexOf(taskId);
      const nextActive =
        pane.activeTabId !== taskId
          ? pane.activeTabId
          : (nextTabs[Math.min(tabIndex, nextTabs.length - 1)] ?? null);
      nextPanes = nextPanes.map((item) =>
        item.id === pane.id ? { ...item, tabs: nextTabs, activeTabId: nextActive } : item,
      );
      continue;
    }
    if (nextPanes.length > 1) {
      const paneIndex = nextPanes.findIndex((item) => item.id === pane.id);
      nextPanes = nextPanes.filter((item) => item.id !== pane.id);
      if (nextActivePaneId === pane.id) {
        nextActivePaneId = nextPanes[Math.min(paneIndex, nextPanes.length - 1)]!.id;
      }
      continue;
    }
    // 最終ペイン（タブ全削除のみ到達）: 空タブのペインへ縮退
    nextPanes = nextPanes.map((item) =>
      item.id === pane.id
        ? { ...item, tabs: [], activeTabId: pane.activeTabId === taskId ? null : pane.activeTabId }
        : item,
    );
  }
  const activePaneId =
    nextPanes.some((pane) => pane.id === nextActivePaneId)
      ? nextActivePaneId
      : (nextPanes[0]?.id ?? null);
  return { ...state, panes: nextPanes, activePaneId };
}

/**
 * 外部由来（localStorage / replace アクション）値の正規化。
 * 破損・構造不一致は null、上限違反・型違いは無害化する。
 */
export function normalize(input: unknown): TaskPanesState | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Partial<TaskPanesState>;
  if (!Array.isArray(raw.panes)) return null;

  const panes: TaskPane[] = [];
  for (const item of raw.panes.slice(0, MAX_PANES)) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Partial<TaskPane>;
    if (typeof candidate.id !== "string" || !candidate.id) continue;
    if (!Array.isArray(candidate.tabs)) continue;
    const tabs: string[] = [];
    for (const tab of candidate.tabs) {
      if (typeof tab !== "string" || !tab || tabs.includes(tab)) continue;
      if (tabs.length >= MAX_TABS_PER_PANE) break;
      tabs.push(tab);
    }
    const activeTabId =
      typeof candidate.activeTabId === "string" && tabs.includes(candidate.activeTabId)
        ? candidate.activeTabId
        : (tabs[0] ?? null);
    panes.push({ id: candidate.id, tabs, activeTabId });
  }
  if (panes.length === 0) return null;
  const activePaneId =
    typeof raw.activePaneId === "string" && panes.some((pane) => pane.id === raw.activePaneId)
      ? raw.activePaneId
      : panes[0].id;
  return raw.orientation === "row" || raw.orientation === "column"
    ? { panes, activePaneId, orientation: raw.orientation }
    : { panes, activePaneId };
}

type StoredTaskPanes = { version: 1 } & TaskPanesState;

export function loadTaskPanes(): TaskPanesState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(TASK_PANES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredTaskPanes;
    if (!parsed || parsed.version !== 1) return null;
    return normalize(parsed);
  } catch {
    return null;
  }
}

export function saveTaskPanes(state: TaskPanesState): void {
  if (typeof localStorage === "undefined") return;
  try {
    const stored = { version: 1, ...state } satisfies StoredTaskPanes;
    localStorage.setItem(TASK_PANES_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* ignore */
  }
}

/** URL パスから taskId を取り出す（/task/<id> 形式のみ）。 */
export function taskIdFromPathname(pathname: string | null | undefined): string | null {
  if (!pathname || !pathname.startsWith("/task/")) return null;
  const encoded = pathname.slice("/task/".length).split("/")[0];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** 分割ホスト（Provider の操作対象）になるパスか。Home・task のみ。 */
export function isSplitHostPath(pathname: string | null | undefined): boolean {
  return pathname === "/" || Boolean(pathname?.startsWith("/task/"));
}

/**
 * アクティブタブを urlTaskId へ向けた新 state を返す（URL → panes 反映用）。
 * タブとして未登録なら panes[0] に新規タブで追加する。満杯時は最も古いタブ
 * （tabs 先頭）を閉じてから新規タブで開く。
 * 変更不要なら同一参照を返す。
 */
export function retargetActiveTab(
  state: TaskPanesState,
  urlTaskId: string,
): TaskPanesState {
  // 新規作成（Home）タブは入口であり、実タスクを開いたら自動クローズする。
  // Home へ戻る遷移では既存タブを活性化、または通常どおり追加する。
  if (urlTaskId !== HOME_TAB_ID) {
    // 残ると非表示マウントの HomeView がポーリングし続け、URL/projectId も不整合になる
    state = removeTaskEverywhere(state, HOME_TAB_ID);
  }
  const existing = state.panes.find((pane) => pane.tabs.includes(urlTaskId));
  if (existing && existing.activeTabId === urlTaskId && state.activePaneId === existing.id) {
    return state;
  }
  if (existing) {
    return {
      ...state,
      activePaneId: existing.id,
      panes: state.panes.map((pane) =>
        pane.id === existing.id ? { ...pane, activeTabId: urlTaskId } : pane,
      ),
    };
  }
  const [first, ...rest] = state.panes;
  const nextFirst: TaskPane = { ...first, activeTabId: urlTaskId };
  // 空きがなければ最も古いタブを閉じてから新規タブとして追加
  nextFirst.tabs =
    first.tabs.length < MAX_TABS_PER_PANE
      ? [...first.tabs, urlTaskId]
      : [...first.tabs.slice(1), urlTaskId];
  return { ...state, panes: [nextFirst, ...rest], activePaneId: first.id };
}

/**
 * localStorage 復元（仕様 §5 の復元順序）:
 * URL taskId を含む構成へ差し替え、含まれない場合は保存 panes[0] の
 * activeTabId を URL taskId に修正して復元。md 未満は null（復元しない）。
 */
export function restoreTaskPanesForUrl(
  urlTaskId: string | null,
  mdUp: boolean,
): TaskPanesState | null {
  if (!mdUp) return null;
  const saved = loadTaskPanes();
  if (!saved) return null;
  if (urlTaskId) {
    const hit = saved.panes.find((pane) => pane.tabs.includes(urlTaskId));
    if (hit) {
      return {
        ...saved,
        activePaneId: hit.id,
        panes: saved.panes.map((pane) =>
          pane.id === hit.id ? { ...pane, activeTabId: urlTaskId } : pane,
        ),
      };
    }
    return retargetActiveTab(saved, urlTaskId);
  }
  return saved;
}
