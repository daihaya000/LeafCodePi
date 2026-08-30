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
  HOME_TAB_ID,
  isSplitHostPath,
  removeTaskEverywhere,
  restoreTaskPanesForUrl,
  retargetActiveTab,
  saveTaskPanes,
  taskIdFromPathname,
  taskPanesReducer,
  type TaskPanesAction,
  type TaskPanesState,
} from "@/lib/task-panes";
import { getJson } from "@/lib/client";
import type { TaskStatus, TaskSummary } from "@/lib/types";

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
  /** タブ表示名（セッション名 = タスク title）。未取得は null。 */
  titleFor: (taskId: string) => string | null;
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
  titleFor: () => null,
};

const TaskPanesContext = createContext<TaskPanesContextValue>(EMPTY);

/** RSC fetch の発生しない URL 同期（Next.js App Router の replaceState 公式サポート）。 */
function syncUrl(taskId: string | null): void {
  if (typeof window === "undefined") return;
  let target: string;
  if (taskId == null || taskId === HOME_TAB_ID) {
    const search =
      taskId === HOME_TAB_ID && window.location.pathname === "/"
        ? new URLSearchParams(window.location.search)
        : null;
    const noProject = search?.get("noProject") === "1";
    const projectId = search?.get("projectId");
    target = noProject
      ? "/?noProject=1"
      : projectId
        ? `/?projectId=${encodeURIComponent(projectId)}`
        : "/";
  } else {
    target = `/task/${encodeURIComponent(taskId)}`;
  }
  if (`${window.location.pathname}${window.location.search}` === target) return;
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
  // 外部遷移（戻る/進む・直リンク）のみ panes 側へ反映。
  const externalUrlRef = useRef<string | null>(null);
  const [statusVersion, bumpStatusVersion] = useReducer(
    (count: number) => count + 1,
    0,
  );
  const statusMapRef = useRef(new Map<string, TaskStatus>());
  const taskTitlesRef = useRef(new Map<string, string>());
  const [titlesVersion, bumpTitlesVersion] = useReducer(
    (count: number) => count + 1,
    0,
  );
  // タスク削除（アーカイブ/DELETE）時の自動クローズ（仕様 §4）。
  // tasks-changed 購読で活タスク ID 集合を見て、消えたタブを全ペインから閉じる。
  // status 報告 map からも除去してタブバッジの残滓を消す。
  // 同時に取得した title をセッション名（タブ表示名）map へも反映する。
  useEffect(() => {
    if (!mdUp) return;
    const onChange = () => {
      void (async () => {
        try {
          // タブ名と存在確認にのみ使う。todoProgress 計算を伴う通常の一覧より軽い。
          const { tasks } = await getJson<{ tasks: TaskSummary[] }>("/api/tasks", { titles: "1" });
          let titlesDirty = false;
          for (const task of tasks) {
            if (taskTitlesRef.current.get(task.id) !== task.title) {
              taskTitlesRef.current.set(task.id, task.title);
              titlesDirty = true;
            }
          }
          if (titlesDirty) bumpTitlesVersion();
          const liveIds = new Set(tasks.map((task) => task.id));
          const latest = latestStateForRetarget;
          if (!latest) return;
          const currentTaskIds = new Set(latest.panes.flatMap((pane) => pane.tabs));
          // Home タブはタスク実体を持たないため自動クローズ対象外
          const missingIds = [...currentTaskIds].filter(
            (taskId) => !liveIds.has(taskId) && taskId !== HOME_TAB_ID,
          );
          if (missingIds.length === 0) return;
          let next = latest;
          for (const taskId of missingIds) {
            next = removeTaskEverywhere(next, taskId);
            statusMapRef.current.delete(taskId);
            taskTitlesRef.current.delete(taskId);
          }
          if (next === latest) return;
          // replace は state 参照を更新し、module 変数経由で次の外部遷移でも追従できる
          // 状態にする。setState 系の version bump は replace とは別系統で発火させる。
          rawDispatch({ type: "replace", state: next });
          bumpStatusVersion();
        } catch {
          /* 取得失敗時は何もしない（閉じ誤り防止） */
        }
      })();
    };
    onChange(); // mount 直後にも 1 回取得（タブ名の初期表示）
    window.addEventListener("webui:tasks-changed", onChange);
    return () => window.removeEventListener("webui:tasks-changed", onChange);
  }, [mdUp]);

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
    externalUrlRef.current = urlTaskId ?? HOME_TAB_ID;
    const saved = restoreTaskPanesForUrl(urlTaskId, true);
    if (!saved) return;
    rawDispatch({ type: "replace", state: saved });
    const savedActive =
      saved.panes.find((pane) => pane.id === saved.activePaneId)?.activeTabId ?? null;
    if (urlTaskId != null) {
      lastUrlSyncRef.current = savedActive;
    } // ルート復元時は保存済み activeTask を URL へ同期させる
  }, [mdUp, urlTaskId]);
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

  // 外部遷移（戻る/進む・直リンク）のみ panes 側へ反映。
  // 「/」は新規作成（Home）タブへ向ける。
  useEffect(() => {
    if (!splitHostEnabled || !mdUp) return;
    const target = urlTaskId ?? HOME_TAB_ID;
    if (externalUrlRef.current === target) return;
    externalUrlRef.current = target;
    rawDispatch(retargetAction(target));
  }, [splitHostEnabled, mdUp, urlTaskId]);

  const activePane =
    state.panes.find((pane) => pane.id === state.activePaneId) ?? state.panes[0];
  const activeTaskId = activePane?.activeTabId ?? null;

  // panes 由来の URL 同期: アクティブタブ変化を replaceState で追わせる。
  // Home タブのアクティブ時は「/」へ寄せる（syncUrl 内で解決）。
  useEffect(() => {
    if (!splitHostEnabled || !mdUp) return;
    if (activeTaskId == null) return;
    if (activeTaskId === lastUrlSyncRef.current) return;
    lastUrlSyncRef.current = activeTaskId;
    externalUrlRef.current = activeTaskId;
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

  // titlesVersion を依存に持たせ、取得時に呼び出し元が再評価されるようにする
  const titleFor = useCallback(
    (taskId: string) => {
      void titlesVersion;
      return taskTitlesRef.current.get(taskId) ?? null;
    },
    [titlesVersion],
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
      titleFor,
    }),
    [state, dispatch, retargetToUrl, activeTaskId, splitHostEnabled, mdUp, statusFor, reportStatus, titleFor],
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
