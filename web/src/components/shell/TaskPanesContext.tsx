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
  useSyncExternalStore,
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
import {
  getBotSidebarServerSnapshot,
  getBotSidebarSnapshot,
  refreshBotSidebar,
  subscribeBotSidebar,
} from "@/lib/bot-sidebar-store";
import type { BotDto, ProjectDto, TaskStatus, TaskSummary } from "@/lib/types";
import { ProjectIcon } from "@/components/ProjectIcon";
import { BotAvatar } from "@/components/bot/BotAvatar";
import { cx } from "@/components/ui";

type TaskIdentity = Pick<TaskSummary, "projectId" | "botId"> & Partial<Pick<TaskSummary, "status">>;
type BotIconData = Pick<BotDto, "id" | "name" | "avatarColor" | "avatarShape" | "avatarEyeColor" | "avatarGlasses" | "avatarMustache" | "avatarImage">;
type ProjectIconData = Pick<ProjectDto, "id" | "name" | "icon">;

function sameBotIconData(left: BotIconData, right: BotIconData): boolean {
  return left.id === right.id && left.name === right.name && left.avatarColor === right.avatarColor
    && left.avatarShape === right.avatarShape && left.avatarEyeColor === right.avatarEyeColor
    && left.avatarGlasses === right.avatarGlasses && left.avatarMustache === right.avatarMustache
    && left.avatarImage === right.avatarImage;
}

function sameProjectIconData(left: ProjectIconData, right: ProjectIconData): boolean {
  return left.id === right.id && left.name === right.name && left.icon === right.icon;
}

function changedIconIds<T extends { id: string }>(
  previous: T[],
  next: T[],
  same: (left: T, right: T) => boolean,
): Set<string> {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const ids = new Set([...previousById.keys(), ...nextById.keys()]);
  return new Set([...ids].filter((id) => {
    const before = previousById.get(id);
    const after = nextById.get(id);
    return before == null || after == null || !same(before, after);
  }));
}

function reuseBotIconData(previous: BotIconData[], bots: readonly BotDto[]): BotIconData[] {
  if (previous.length === bots.length && previous.every((item, index) => sameBotIconData(item, bots[index]))) return previous;
  return bots.map(({ id, name, avatarColor, avatarShape, avatarEyeColor, avatarGlasses, avatarMustache, avatarImage }) => ({
    id, name, avatarColor, avatarShape, avatarEyeColor, avatarGlasses, avatarMustache, avatarImage,
  }));
}

function reuseProjectIconData(previous: ProjectIconData[], projects: readonly ProjectDto[]): ProjectIconData[] {
  if (previous.length === projects.length && previous.every((item, index) => sameProjectIconData(item, projects[index]))) return previous;
  return projects.map(({ id, name, icon }) => ({ id, name, icon }));
}

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

type TaskPanesStableContextValue = {
  reportStatus: TaskPanesContextValue["reportStatus"];
  getStatusFor: (taskId: string) => TaskStatus | null;
  botFor: (botId?: string) => BotDto | undefined;
};

type TaskPanesTabMetaSnapshot = Readonly<{
  status: TaskStatus | null;
  title: string | null;
  iconVersion: number;
}>;

type TaskPanesTabMetaStoreValue = {
  subscribe: (taskId: string, listener: () => void) => () => void;
  getSnapshot: (taskId: string) => TaskPanesTabMetaSnapshot;
};

type TaskPanesIconContextValue = {
  iconFor: (taskId: string, size?: 16 | 32, task?: TaskIdentity) => React.ReactNode;
};
type TaskPanesTaskIconContextValue = TaskPanesIconContextValue;

type TaskPanesBotStatusContextValue = {
  statusFor: (taskId: string) => TaskStatus | null;
};

type TaskPanesNavigationContextValue = Pick<
  TaskPanesContextValue,
  "state" | "dispatch" | "retargetToUrl" | "activeTaskId" | "splitHostEnabled" | "mdUp"
>;

const EMPTY_STABLE: TaskPanesStableContextValue = {
  reportStatus: () => undefined,
  getStatusFor: () => null,
  botFor: () => undefined,
};
const EMPTY_TAB_META_SNAPSHOT: TaskPanesTabMetaSnapshot = { status: null, title: null, iconVersion: 0 };
const EMPTY_TAB_META_STORE: TaskPanesTabMetaStoreValue = {
  subscribe: () => () => undefined,
  getSnapshot: () => EMPTY_TAB_META_SNAPSHOT,
};
const EMPTY_ICON: TaskPanesIconContextValue = { iconFor: () => null };
const EMPTY_TASK_ICON: TaskPanesTaskIconContextValue = EMPTY_ICON;
const EMPTY_BOT_STATUS: TaskPanesBotStatusContextValue = { statusFor: () => null };
const EMPTY_NAVIGATION: TaskPanesNavigationContextValue = {
  state: { panes: [], activePaneId: null },
  dispatch: () => undefined,
  retargetToUrl: () => undefined,
  activeTaskId: null,
  splitHostEnabled: false,
  mdUp: false,
};

const TaskPanesStableContext = createContext<TaskPanesStableContextValue>(EMPTY_STABLE);
const TaskPanesTabMetaContext = createContext<TaskPanesTabMetaStoreValue>(EMPTY_TAB_META_STORE);
const TaskPanesIconContext = createContext<TaskPanesIconContextValue>(EMPTY_ICON);
const TaskPanesTaskIconContext = createContext<TaskPanesTaskIconContextValue>(EMPTY_TASK_ICON);
const TaskPanesBotStatusContext = createContext<TaskPanesBotStatusContextValue>(EMPTY_BOT_STATUS);
const TaskPanesNavigationContext = createContext<TaskPanesNavigationContextValue>(EMPTY_NAVIGATION);
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
  const [botStatusVersion, bumpBotStatusVersion] = useReducer(
    (count: number) => count + 1,
    0,
  );
  const statusMapRef = useRef(new Map<string, TaskStatus>());
  const taskTitlesRef = useRef(new Map<string, string>());
  const taskIdentitiesRef = useRef(new Map<string, TaskIdentity>());
  const iconBotsRef = useRef<BotIconData[]>([]);
  const iconProjectsRef = useRef<ProjectIconData[]>([]);
  const previousIconBotsRef = useRef<BotIconData[]>([]);
  const previousIconProjectsRef = useRef<ProjectIconData[]>([]);
  const iconForRef = useRef<TaskPanesIconContextValue["iconFor"]>(EMPTY_ICON.iconFor);
  const tabMetaSnapshotsRef = useRef(new Map<string, TaskPanesTabMetaSnapshot>());
  const tabMetaIconVersionsRef = useRef(new Map<string, number>());
  const tabMetaListenersRef = useRef(new Map<string, Set<() => void>>());
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const botSidebar = useSyncExternalStore(
    subscribeBotSidebar,
    getBotSidebarSnapshot,
    getBotSidebarServerSnapshot,
  );
  const { bots, rooms } = botSidebar;
  const iconBots = useMemo(() => {
    const next = reuseBotIconData(iconBotsRef.current, bots);
    iconBotsRef.current = next;
    return next;
  }, [bots]);
  const iconProjects = useMemo(() => {
    const next = reuseProjectIconData(iconProjectsRef.current, projects);
    iconProjectsRef.current = next;
    return next;
  }, [projects]);
  const getTabMetaSnapshot = useCallback((taskId: string): TaskPanesTabMetaSnapshot => {
    const existing = tabMetaSnapshotsRef.current.get(taskId);
    if (existing) return existing;
    const snapshot: TaskPanesTabMetaSnapshot = {
      status: statusMapRef.current.get(taskId) ?? null,
      title: taskTitlesRef.current.get(taskId) ?? null,
      iconVersion: tabMetaIconVersionsRef.current.get(taskId) ?? 0,
    };
    tabMetaSnapshotsRef.current.set(taskId, snapshot);
    return snapshot;
  }, []);
  const emitTabMeta = useCallback((taskId: string) => {
    const next: TaskPanesTabMetaSnapshot = {
      status: statusMapRef.current.get(taskId) ?? null,
      title: taskTitlesRef.current.get(taskId) ?? null,
      iconVersion: tabMetaIconVersionsRef.current.get(taskId) ?? 0,
    };
    const current = tabMetaSnapshotsRef.current.get(taskId);
    if (current?.status === next.status && current.title === next.title && current.iconVersion === next.iconVersion) return;
    tabMetaSnapshotsRef.current.set(taskId, next);
    tabMetaListenersRef.current.get(taskId)?.forEach((listener) => listener());
  }, []);
  const bumpTabIconVersion = useCallback((taskId: string) => {
    const next = (tabMetaIconVersionsRef.current.get(taskId) ?? 0) + 1;
    tabMetaIconVersionsRef.current.set(taskId, next);
    emitTabMeta(taskId);
  }, [emitTabMeta]);
  const subscribeTabMeta = useCallback((taskId: string, listener: () => void) => {
    const listeners = tabMetaListenersRef.current.get(taskId) ?? new Set<() => void>();
    listeners.add(listener);
    tabMetaListenersRef.current.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) tabMetaListenersRef.current.delete(taskId);
    };
  }, []);

  useEffect(() => {
    const changedBotIds = changedIconIds(previousIconBotsRef.current, iconBots, sameBotIconData);
    const changedProjectIds = changedIconIds(previousIconProjectsRef.current, iconProjects, sameProjectIconData);
    if (changedBotIds.size > 0 || changedProjectIds.size > 0) {
      const changedBotTabIds = new Set([...changedBotIds].map((botId) => `/bots/${encodeURIComponent(botId)}`));
      for (const taskId of state.panes.flatMap((pane) => pane.tabs)) {
        const identity = taskIdentitiesRef.current.get(taskId);
        const botChanged = identity?.botId != null && changedBotIds.has(identity.botId)
          || changedBotTabIds.has(taskId);
        const projectChanged = identity?.projectId != null && changedProjectIds.has(identity.projectId);
        if (botChanged || projectChanged) bumpTabIconVersion(taskId);
      }
    }
    previousIconBotsRef.current = iconBots;
    previousIconProjectsRef.current = iconProjects;
  }, [bumpTabIconVersion, iconBots, iconProjects, state]);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const result = await getJson<{ projects: ProjectDto[] }>("/api/projects?archived=1");
        if (!disposed && request === generation) {
          setProjects(Array.isArray(result.projects) ? result.projects : []);
        }
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
            const identityChanged = identity?.projectId !== task.projectId || identity?.botId !== task.botId;
            const titleChanged = taskTitlesRef.current.get(task.id) !== task.title;
            if (identityChanged) {
              taskIdentitiesRef.current.set(task.id, { projectId: task.projectId, botId: task.botId });
              titlesDirty = true;
            }
            if (titleChanged) {
              taskTitlesRef.current.set(task.id, task.title);
              titlesDirty = true;
            }
            if (identityChanged) bumpTabIconVersion(task.id);
            else if (titleChanged) emitTabMeta(task.id);
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
            bumpTabIconVersion(taskId);
          }
          if (next === latest) return;
          // replace は state 参照を更新し、module 変数経由で次の外部遷移でも追従できる
          // 状態にする。setState 系の version bump は replace とは別系統で発火させる。
          rawDispatch({ type: "replace", state: next });
          bumpStatusVersion();
          if (missingIds.some(isBotTabId)) bumpBotStatusVersion();
        } catch {
          /* 取得失敗時は何もしない（閉じ誤り防止） */
        }
      })();
    };
    onChange(); // mount 直後にも 1 回取得（タブ名の初期表示）
    window.addEventListener("webui:tasks-changed", onChange);
    return () => window.removeEventListener("webui:tasks-changed", onChange);
  }, [bumpTabIconVersion, emitTabMeta, mdUp]);

  useEffect(() => {
    const titles = new Map<string, string>([
      [BOTS_TAB_ID, "Bot一覧"],
      ...bots.map((bot): [string, string] => [`/bots/${encodeURIComponent(bot.id)}`, bot.name]),
      ...rooms.map((room): [string, string] => [`/bots/rooms/${encodeURIComponent(room.id)}`, room.name]),
    ]);
    let titlesDirty = false;
    for (const [id, title] of titles) {
      if (taskTitlesRef.current.get(id) === title) continue;
      taskTitlesRef.current.set(id, title);
      emitTabMeta(id);
      titlesDirty = true;
    }
    const latest = latestStateForRetarget;
    if (latest) {
      let next = latest;
      for (const id of latest.panes.flatMap((pane) => pane.tabs)) {
        if (isBotTabId(id) && !titles.has(id)) {
          next = removeTaskEverywhere(next, id);
          if (taskTitlesRef.current.delete(id)) titlesDirty = true;
        }
      }
      if (next !== latest) rawDispatch({ type: "replace", state: next });
    }
    if (titlesDirty) bumpTitlesVersion();
  }, [bots, emitTabMeta, rooms]);

  useEffect(() => {
    const onBotSidebarChanged = (event: Event) => {
      const refreshToken = (event as CustomEvent<{ refresh?: string }>).detail?.refresh;
      void refreshBotSidebar(refreshToken).catch(() => undefined);
    };
    void refreshBotSidebar().catch(() => undefined);
    window.addEventListener("webui:bot-sidebar-changed", onBotSidebarChanged);
    return () => window.removeEventListener("webui:bot-sidebar-changed", onBotSidebarChanged);
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

  const getStatusFor = useCallback(
    (taskId: string) => statusMapRef.current.get(taskId) ?? null,
    [],
  );

  const reportStatus = useCallback((taskId: string, status: TaskStatus) => {
    if (statusMapRef.current.get(taskId) === status) return;
    statusMapRef.current.set(taskId, status);
    emitTabMeta(taskId);
    bumpStatusVersion();
    if (isBotTabId(taskId)) bumpBotStatusVersion();
  }, [emitTabMeta]);

  // statusVersion を依存に持たせ、報告時に呼び出し元が再評価されるようにする
  const statusFor = useCallback(
    (taskId: string) => {
      void statusVersion;
      return getStatusFor(taskId);
    },
    [getStatusFor, statusVersion],
  );
  const botStatusFor = useCallback(
    (taskId: string) => {
      void botStatusVersion;
      return getStatusFor(taskId);
    },
    [botStatusVersion, getStatusFor],
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
    const bot = iconBots.find((item) => item.id === identity?.botId)
      ?? iconBots.find((item) => `/bots/${encodeURIComponent(item.id)}` === taskId);
    if (bot || identity?.botId) {
      return <span aria-hidden="true" className="shrink-0"><BotAvatar size={size} {...bot} active={(task?.status ?? statusMapRef.current.get(taskId)) === "working"} /></span>;
    }
    const project = iconProjects.find((item) => item.id === identity?.projectId);
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
  }, [iconBots, iconProjects, titlesVersion]);
  iconForRef.current = iconFor;
  const taskIconFor = useCallback(
    (taskId: string, size?: 16 | 32, task?: TaskIdentity) => iconForRef.current(taskId, size, task),
    [],
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
  const stableValue = useMemo<TaskPanesStableContextValue>(
    () => ({ reportStatus, getStatusFor, botFor }),
    [reportStatus, getStatusFor, botFor],
  );
  const tabMetaStoreValue = useMemo<TaskPanesTabMetaStoreValue>(
    () => ({ subscribe: subscribeTabMeta, getSnapshot: getTabMetaSnapshot }),
    [getTabMetaSnapshot, subscribeTabMeta],
  );
  const iconValue = useMemo<TaskPanesIconContextValue>(() => ({ iconFor }), [iconFor]);
  const taskIconValue = useMemo<TaskPanesTaskIconContextValue>(
    () => ({ iconFor: taskIconFor }),
    [taskIconFor],
  );
  const botStatusValue = useMemo<TaskPanesBotStatusContextValue>(
    () => ({ statusFor: botStatusFor }),
    [botStatusFor],
  );
  const navigationValue = useMemo<TaskPanesNavigationContextValue>(
    () => ({ state, dispatch, retargetToUrl, activeTaskId, splitHostEnabled, mdUp }),
    [state, dispatch, retargetToUrl, activeTaskId, splitHostEnabled, mdUp],
  );

  return (
    <TaskPanesStableContext.Provider value={stableValue}>
      <TaskPanesBotStatusContext.Provider value={botStatusValue}>
        <TaskPanesTabMetaContext.Provider value={tabMetaStoreValue}>
          <TaskPanesIconContext.Provider value={iconValue}>
            <TaskPanesTaskIconContext.Provider value={taskIconValue}>
              <TaskPanesNavigationContext.Provider value={navigationValue}>
                <TaskPanesContext.Provider value={value}>{children}</TaskPanesContext.Provider>
              </TaskPanesNavigationContext.Provider>
            </TaskPanesTaskIconContext.Provider>
          </TaskPanesIconContext.Provider>
        </TaskPanesTabMetaContext.Provider>
      </TaskPanesBotStatusContext.Provider>
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
export function useBotFor(): TaskPanesStableContextValue["botFor"] {
  return useContext(TaskPanesStableContext).botFor;
}

export function useReportStatus(): TaskPanesContextValue["reportStatus"] {
  return useContext(TaskPanesStableContext).reportStatus;
}

export function useGetStatusFor(): TaskPanesStableContextValue["getStatusFor"] {
  return useContext(TaskPanesStableContext).getStatusFor;
}

export function useTaskPaneTabMeta(taskId: string): TaskPanesTabMetaSnapshot {
  const store = useContext(TaskPanesTabMetaContext);
  const subscribe = useCallback((listener: () => void) => store.subscribe(taskId, listener), [store, taskId]);
  const getSnapshot = useCallback(() => store.getSnapshot(taskId), [store, taskId]);
  const getServerSnapshot = useCallback(() => EMPTY_TAB_META_SNAPSHOT, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useIconFor(): TaskPanesIconContextValue["iconFor"] {
  return useContext(TaskPanesIconContext).iconFor;
}

export function useTaskPaneIconFor(): TaskPanesTaskIconContextValue["iconFor"] {
  return useContext(TaskPanesTaskIconContext).iconFor;
}

export function useBotStatusFor(): TaskPanesBotStatusContextValue["statusFor"] {
  return useContext(TaskPanesBotStatusContext).statusFor;
}

export function useTaskPanesNavigation(): TaskPanesNavigationContextValue {
  return useContext(TaskPanesNavigationContext);
}
