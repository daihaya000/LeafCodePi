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
  BOTS_TAB_ID,
  isBotTabId,
  HOME_TAB_ID,
  isSplitHostPath,
  SETTINGS_TAB_ID,
  removeTaskEverywhere,
  restoreTaskPanesForUrl,
  retargetActiveTab,
  saveTaskPanes,
  tabIdFromPathname,
  taskIdsToAutoClose,
  taskPanesReducer,
  type TaskPanesAction,
  type TaskPanesState,
} from "@/lib/task-panes";
import { getJson } from "@/lib/client";
import type { BotDto, ProjectDto, TaskStatus, TaskSummary } from "@/lib/types";
import { ProjectIcon } from "@/components/ProjectIcon";
import { BotAvatar } from "@/components/bot/BotAvatar";
import { cx } from "@/components/ui";

type TaskIdentity = Pick<TaskSummary, "projectId" | "botId"> & Partial<Pick<TaskSummary, "status">>;

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
  botFor: (botId?: string) => BotDto | undefined;
  iconFor: (taskId: string, size?: 16 | 32, task?: TaskIdentity) => React.ReactNode;
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
  botFor: () => undefined,
  iconFor: () => null,
};

type TaskPanesStableContextValue = Pick<TaskPanesContextValue, "reportStatus" | "botFor">;

const EMPTY_STABLE: TaskPanesStableContextValue = {
  reportStatus: () => undefined,
  botFor: () => undefined,
};

const TaskPanesStableContext = createContext<TaskPanesStableContextValue>(EMPTY_STABLE);
const TaskPanesContext = createContext<TaskPanesContextValue>(EMPTY);

/** RSC fetch の発生しない URL 同期（Next.js App Router の replaceState 公式サポート）。 */
function syncUrl(tabId: string | null): void {
  if (typeof window === "undefined") return;
  let target: string;
  if (isBotTabId(tabId)) {
    target = tabId!;
  } else if (tabId === SETTINGS_TAB_ID) {
    target = "/settings";
  } else if (tabId == null || tabId === HOME_TAB_ID) {
    const search =
      tabId === HOME_TAB_ID && window.location.pathname === "/"
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
    target = `/task/${encodeURIComponent(tabId)}`;
  }
  if (`${window.location.pathname}${window.location.search}` === target) return;
  window.history.replaceState(null, "", target);
}

export function TaskPanesProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const urlTaskId = tabIdFromPathname(pathname);
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
  const taskIdentitiesRef = useRef(new Map<string, TaskIdentity>());
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [bots, setBots] = useState<BotDto[]>([]);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const result = await getJson<{ projects: ProjectDto[] }>("/api/projects?archived=1");
        if (!disposed && request === generation) setProjects(result.projects);
      } catch { /* Keep existing icons on fetch failure. */ }
    };
    void refresh();
    window.addEventListener("webui:tasks-changed", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("webui:tasks-changed", refresh);
    };
  }, []);
  const knownActiveTaskIdsRef = useRef(new Set<string>());
  const [titlesVersion, bumpTitlesVersion] = useReducer(
    (count: number) => count + 1,
    0,
  );
  // タスク削除（hard DELETE）と、開いていた非アーカイブタブの新規アーカイブ時に
  // 自動クローズする（仕様 §4）。サイドバーから開き直した archived 履歴タブは残す。
  // tasks-changed 購読で存在確認し、status 報告 map からも除去してタブバッジの残滓を消す。
  // 同時に取得した title をセッション名（タブ表示名）map へも反映する。
  useEffect(() => {
    if (!mdUp) return;
    const onChange = () => {
      void (async () => {
        try {
          // タブ名と存在確認にのみ使う。todoProgress 計算を伴う通常の一覧より軽い。
          const { tasks } = await getJson<{ tasks: TaskSummary[] }>("/api/tasks", {
            titles: "1",
            archived: "1",
          });
          let titlesDirty = false;
          for (const task of tasks) {
            const identity = taskIdentitiesRef.current.get(task.id);
            if (identity?.projectId !== task.projectId || identity?.botId !== task.botId) {
              taskIdentitiesRef.current.set(task.id, { projectId: task.projectId, botId: task.botId });
              titlesDirty = true;
            }
            if (taskTitlesRef.current.get(task.id) !== task.title) {
              taskTitlesRef.current.set(task.id, task.title);
              titlesDirty = true;
            }
          }
          if (titlesDirty) bumpTitlesVersion();
          const existingIds = new Set(tasks.map((task) => task.id));
          const activeIds = new Set(
            tasks
              .filter((task) => task.status !== "archived")
              .map((task) => task.id),
          );
          const latest = latestStateForRetarget;
          if (!latest) {
            knownActiveTaskIdsRef.current = activeIds;
            return;
          }
          const currentTaskIds = latest.panes.flatMap((pane) => pane.tabs);
          const missingIds = taskIdsToAutoClose({
            openTaskIds: currentTaskIds,
            existingIds,
            activeIds,
            previouslyActiveIds: knownActiveTaskIdsRef.current,
          });
          knownActiveTaskIdsRef.current = activeIds;
          if (missingIds.length === 0) return;
          let next = latest;
          for (const taskId of missingIds) {
            next = removeTaskEverywhere(next, taskId);
            statusMapRef.current.delete(taskId);
            taskTitlesRef.current.delete(taskId);
            taskIdentitiesRef.current.delete(taskId);
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

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = async (refreshToken?: string) => {
      const request = ++generation;
      try {
        const { bots, rooms } = await getJson<{
          bots: BotDto[];
          rooms: { id: string; name: string }[];
        }>("/api/bots/sidebar", refreshToken ? { refresh: refreshToken } : undefined);
        if (disposed || request !== generation) return;
        setBots(bots);
        const titles = new Map<string, string>([
          [BOTS_TAB_ID, "Bot一覧"],
          ...bots.map((bot): [string, string] => [`/bots/${encodeURIComponent(bot.id)}`, bot.name]),
          ...rooms.map((room): [string, string] => [`/bots/rooms/${encodeURIComponent(room.id)}`, room.name]),
        ]);
        for (const [id, title] of titles) taskTitlesRef.current.set(id, title);
        const latest = latestStateForRetarget;
        if (latest) {
          let next = latest;
          for (const id of latest.panes.flatMap((pane) => pane.tabs)) {
            if (isBotTabId(id) && !titles.has(id)) {
              next = removeTaskEverywhere(next, id);
              taskTitlesRef.current.delete(id);
            }
          }
          if (next !== latest) rawDispatch({ type: "replace", state: next });
        }
        bumpTitlesVersion();
      } catch {
        /* Keep tabs on fetch failure. */
      }
    };
    const onBotSidebarChanged = (event: Event) => {
      const refreshToken = (event as CustomEvent<{ refresh?: string }>).detail?.refresh;
      void refresh(refreshToken);
    };
    void refresh();
    window.addEventListener("webui:bot-sidebar-changed", onBotSidebarChanged);
    return () => {
      disposed = true;
      window.removeEventListener("webui:bot-sidebar-changed", onBotSidebarChanged);
    };
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
    if (activeTaskId == null) {
      if (lastUrlSyncRef.current === HOME_TAB_ID) return;
      lastUrlSyncRef.current = HOME_TAB_ID;
      externalUrlRef.current = HOME_TAB_ID;
      syncUrl(HOME_TAB_ID);
      return;
    }
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

  const botFor = useCallback(
    (botId?: string) => (botId ? bots.find((item) => item.id === botId) : undefined),
    [bots],
  );

  const iconFor = useCallback((taskId: string, size: 16 | 32 = 16, task?: TaskIdentity) => {
    void titlesVersion;
    const identity = task ?? taskIdentitiesRef.current.get(taskId);
    const bot =
      botFor(identity?.botId) ??
      bots.find((item) => `/bots/${encodeURIComponent(item.id)}` === taskId);
    if (bot || identity?.botId) {
      return <span aria-hidden="true" className="shrink-0"><BotAvatar size={size} {...bot} active={(task?.status ?? statusFor(taskId)) === "working"} /></span>;
    }
    const project = projects.find((item) => item.id === identity?.projectId);
    return project ? (
      <span aria-hidden="true" className="shrink-0">
        <ProjectIcon project={project} className={cx(
          size === 32
            ? "flex h-8 w-8 items-center justify-center rounded-md text-sm font-semibold"
            : "flex h-4 w-4 items-center justify-center rounded-md text-[10px] font-semibold",
          !project.icon && "border",
        )} />
      </span>
    ) : null;
  }, [botFor, bots, projects, titlesVersion, statusFor]);

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
      botFor,
      iconFor,
    }),
    [state, dispatch, retargetToUrl, activeTaskId, splitHostEnabled, mdUp, statusFor, reportStatus, titleFor, botFor, iconFor],
  );
  const stableValue = useMemo<TaskPanesStableContextValue>(
    () => ({ reportStatus, botFor }),
    [reportStatus, botFor],
  );

  return (
    <TaskPanesStableContext.Provider value={stableValue}>
      <TaskPanesContext.Provider value={value}>{children}</TaskPanesContext.Provider>
    </TaskPanesStableContext.Provider>
  );
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

/**
 * Status updates are frequent while a task streams. Consumers that only need
 * stable pane services must not subscribe to the full, status-aware context.
 */
export function useBotFor(): TaskPanesContextValue["botFor"] {
  return useContext(TaskPanesStableContext).botFor;
}

export function useReportStatus(): TaskPanesContextValue["reportStatus"] {
  return useContext(TaskPanesStableContext).reportStatus;
}
