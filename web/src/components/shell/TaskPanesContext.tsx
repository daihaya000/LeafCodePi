"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import {
  createState,
  isSplitHostPath,
  restoreTaskPanesForUrl,
  retargetActiveTab,
  saveTaskPanes,
  taskIdFromPathname,
  taskPanesReducer,
  type TaskPanesAction,
  type TaskPanesState,
} from "@/lib/task-panes";
import type { TaskStatus } from "@/lib/types";

const SAVE_DEBOUNCE_MS = 500;
const MD_QUERY = "(min-width: 768px)";

type TaskPanesContextValue = {
  state: TaskPanesState;
  dispatch: (action: TaskPanesAction) => void;
  /** URL → panes 反映（戻る/進む・直リンク）。 */
  retargetToUrl: (taskId: string) => void;
  /** アクティブペインの activeTabId（Sidebar ハイライト等の追従源）。 */
  activeTaskId: string | null;
  splitHostEnabled: boolean;
  mdUp: boolean;
  /** タブバッジ用。TaskView の SSE snapshot が報告した最新 status。 */
  statusFor: (taskId: string) => TaskStatus | null;
  reportStatus: (taskId: string, status: TaskStatus) => void;
};

const EMPTY: TaskPanesContextValue = {
  state: { panes: [], activePaneId: null },
  dispatch: () => undefined,
  retargetToUrl: () => undefined,
  activeTaskId: null,
  splitHostEnabled: false,
  mdUp: false,
  statusFor: () => null,
  reportStatus: () => undefined,
};

const TaskPanesContext = createContext<TaskPanesContextValue>(EMPTY);

/** RSC fetch の発生しない URL 同期（Next.js App Router の replaceState 公式サポート）。 */
function syncUrl(taskId: string | null): void {
  if (typeof window === "undefined") return;
  const target = taskId ? `/task/${encodeURIComponent(taskId)}` : "/";
  if (window.location.pathname === target) return;
  window.history.replaceState(null, "", target);
}

export function TaskPanesProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const urlTaskId = taskIdFromPathname(pathname);
  const splitHostEnabled = isSplitHostPath(pathname);

  // wrapDispatch: replace 前に retargetActiveTab を適用できるよう action を素通し
  const [state, rawDispatch] = useReducer(
    (current: TaskPanesState, action: TaskPanesAction) =>
      trackLatestState(taskPanesReducer(current, action)),
    urlTaskId,
    (id) => trackLatestState(createState(id)),
  );
  const [mdUp, setMdUp] = useState(false);
  const restoredRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUrlSyncRef = useRef<string | null>(urlTaskId ?? null);
  const [statusVersion, bumpStatusVersion] = useReducer(
    (count: number) => count + 1,
    0,
  );
  const statusMapRef = useRef(new Map<string, TaskStatus>());

  const dispatch = useCallback((action: TaskPanesAction) => {
    rawDispatch(action);
  }, []);

  // localStorage 復元: 初回 mount・md 以上のみ（仕様 §5）
  useEffect(() => {
    if (restoredRef.current) return;
    if (typeof window.matchMedia !== "function") return;
    if (!window.matchMedia(MD_QUERY).matches) {
      setMdUp(false);
      return;
    }
    setMdUp(true);
    restoredRef.current = true;
    const saved = restoreTaskPanesForUrl(urlTaskId, true);
    if (!saved) return;
    rawDispatch({ type: "replace", state: saved });
    const savedActive =
      saved.panes.find((pane) => pane.id === saved.activePaneId)?.activeTabId ?? null;
    lastUrlSyncRef.current = savedActive; // 復元構成に合わせたので以後は panes 観測で同期
  }, [urlTaskId]);
  // md 幅の追跡
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(MD_QUERY);
    const update = () => setMdUp(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // panes 変更を localStorage へデバウンス保存。
  // md 未満では復元しない仕様（§5）と対になるよう、保存も md 以上に限定する
  // （モバイル初期 state で既存レイアウトを上書きしないため）。
  useEffect(() => {
    if (!mdUp) return;
    if (saveTimerRef.current != null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      saveTaskPanes(state);
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current != null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [state, mdUp]);

  // 外部遷移（戻る/進む・直リンク）のみ panes 側へ反映
  const externalUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!splitHostEnabled || !mdUp || !urlTaskId) return;
    if (externalUrlRef.current === urlTaskId) return;
    externalUrlRef.current = urlTaskId;
    rawDispatch(retargetAction(urlTaskId));
  }, [splitHostEnabled, mdUp, urlTaskId]);

  const activePane =
    state.panes.find((pane) => pane.id === state.activePaneId) ?? state.panes[0];
  const activeTaskId = activePane?.activeTabId ?? null;

  // panes 由来の URL 同期: アクティブタブ変化を replaceState で追わせる
  useEffect(() => {
    if (!splitHostEnabled || !mdUp) return;
    if (activeTaskId == null) return;
    if (activeTaskId === lastUrlSyncRef.current) return;
    lastUrlSyncRef.current = activeTaskId;
    syncUrl(activeTaskId);
  }, [splitHostEnabled, mdUp, activeTaskId]);

  const retargetToUrl = useCallback((taskId: string) => {
    rawDispatch(retargetAction(taskId));
  }, []);

  const reportStatus = useCallback((taskId: string, status: TaskStatus) => {
    if (statusMapRef.current.get(taskId) === status) return;
    statusMapRef.current.set(taskId, status);
    bumpStatusVersion();
  }, []);

  // statusVersion を依存に持たせ、報告時に呼び出し元が再評価されるようにする
  const statusFor = useCallback(
    (taskId: string) => {
      void statusVersion;
      return statusMapRef.current.get(taskId) ?? null;
    },
    [statusVersion],
  );

  const value = useMemo<TaskPanesContextValue>(
    () => ({
      state,
      dispatch,
      retargetToUrl,
      activeTaskId,
      splitHostEnabled,
      mdUp,
      statusFor,
      reportStatus,
    }),
    [state, dispatch, retargetToUrl, activeTaskId, splitHostEnabled, mdUp, statusFor, reportStatus],
  );

  return <TaskPanesContext.Provider value={value}>{children}</TaskPanesContext.Provider>;
}

/**
 * URL → panes 反映アクション。reducer は replace しか知らないため、
 * 現在 state へ retargetActiveTab を適用した結果を replace で渡す。
 * action 生成時に最新 state を見るため、reducer 実行ごとに module 変数へ記録する。
 */
let latestStateForRetarget: TaskPanesState | null = null;

function trackLatestState(state: TaskPanesState): TaskPanesState {
  latestStateForRetarget = state;
  return state;
}

function retargetAction(taskId: string): TaskPanesAction {
  const base = latestStateForRetarget;
  if (!base) return { type: "replace", state: createState(taskId) };
  return { type: "replace", state: retargetActiveTab(base, taskId) };
}

export function useTaskPanes(): TaskPanesContextValue {
  return useContext(TaskPanesContext);
}
