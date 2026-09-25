"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Archive,
  ArchiveRestore,
  ChevronRight,
  CircleAlert,
  CodeXml,
  Cpu,
  Folder,
  FolderUp,
  Loader2,
  Menu,
  Plus,
  Pin,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { AddProjectButton } from "@/components/AddProjectButton";
import { WorkingTasksButton } from "@/components/WorkingTasksButton";
import { ProjectIcon } from "@/components/ProjectIcon";
import { discoverExplorerTarget, type ExplorerTarget } from "@/components/task/ProjectExplorerButton";
import { CodexBarWidget } from "@/components/codexbar/CodexBarWidget";
import { SystemMonitorWidget } from "@/components/sysmon/SystemMonitorWidget";
import { useBotStatusFor, useTaskPanesNavigation } from "@/components/shell/TaskPanesContext";
import { SwipeArchiveRow } from "@/components/shell/SwipeArchiveRow";
import { Button, cx, timeAgo } from "@/components/ui";
import { SessionLabelBadge } from "@/components/SessionLabelBadge";
import { BotAvatar, type BotFace } from "@/components/bot/BotAvatar";
import { isTaskDrag, setTaskDragData } from "@/lib/task-drag";
import { notifyBotSidebarChanged, notifyTasksChanged } from "@/lib/events";
import { getJson, sendJson } from "@/lib/client";
import {
  getBotSidebarServerSnapshot,
  getBotSidebarSnapshot,
  refreshBotSidebar,
  subscribeBotSidebar,
} from "@/lib/bot-sidebar-store";
import { getLastReadAt, getUnreadSnapshot, hasUnread, hydrateLastReadState, markRead, subscribeUnreadState } from "@/lib/bot-unread";
import { HOME_TAB_ID, paneTabIdsForWorkingTasks, SETTINGS_TAB_ID, type TaskPanesAction } from "@/lib/task-panes";
import { PINNED_TASKS_API_PATH, parsePinnedTaskIds, serializePinnedTaskIds } from "@/lib/sidebar-settings";
import { isGoalLoopLiveStatus } from "@/lib/goal-loop-settings";
import { NO_PROJECT_NAME, type BotDto, type HealthDto, type RoomDto, type ProjectDto, type ProjectIconColor, type TaskSummary } from "@/lib/types";

type ProjectTaskMenuState = {
  projectId: string;
  top: number;
  left: number;
};

type RailWidget = "codexbar" | "sysmon";
type ProjectDropPlacement = "before" | "after";

const WIDTH_KEY = "webui.sidebar.width";
const COLLAPSED_KEY = "webui.sidebar.collapsed";
const EXPANDED_KEY = "webui.sidebar.expanded";
const PROJECT_ORDER_KEY = "webui.sidebar.project_order";
/** 旧localStorage値の一度きりのサーバー移行にだけ使う。 */
const LEGACY_PINNED_TASKS_KEY = "webui.sidebar.pinned_tasks";
const ARCHIVED_EXPANDED_KEY = "webui.sidebar.archived_expanded";
const ARCHIVED_PROJECTS_EXPANDED_KEY = "webui.sidebar.archived_projects_expanded";
const DEFAULT_WIDTH = 240;
const COLLAPSED_WIDTH = 80;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const POLL_IDLE_MS = 12_000;
const POLL_WORKING_MS = 4_000;
const PROJECT_DRAG_MIME = "application/x-leafcode-project";
const HOVER_QUERY = "(hover: hover)";
const NO_PROJECT_GROUP_ID = "__leafcode_no_project__";

/**
 * ドラッグ中の生の幅から表示モードを決める。
 * MIN_WIDTH を下回ったら最小表示（レール）へ切り替え、そこでは保存用の幅を更新しない
 * （通常表示へ戻したときは直前に使っていた幅を復元する）。
 */
function resolveSidebarDrag(rawWidth: number): { collapsed: boolean; width: number | null } {
  if (rawWidth < MIN_WIDTH) return { collapsed: true, width: null };
  return { collapsed: false, width: Math.min(MAX_WIDTH, rawWidth) };
}

/** 表示に影響するフィールドのみ比較（未変更なら参照を維持して再レンダーを防ぐ）。 */
function sameTaskSummary(left: TaskSummary, right: TaskSummary): boolean {
  return left.id === right.id &&
    left.status === right.status &&
    left.title === right.title &&
    left.projectId === right.projectId &&
    left.projectName === right.projectName &&
    left.botId === right.botId &&
    left.supervisorBotId === right.supervisorBotId &&
    left.updatedAt === right.updatedAt &&
    left.todoProgress?.completed === right.todoProgress?.completed &&
    left.todoProgress?.total === right.todoProgress?.total &&
    left.goalLoopSummary?.status === right.goalLoopSummary?.status &&
    left.goalLoopSummary?.maxTurns === right.goalLoopSummary?.maxTurns &&
    left.goalLoopSummary?.turnCount === right.goalLoopSummary?.turnCount;
}

export function sameTaskList(a: TaskSummary[], b: TaskSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!sameTaskSummary(a[index]!, b[index]!)) return false;
  }
  return true;
}

/** Reuse unchanged task objects so memoized row details skip updates when one task changes. */
export function stabilizeTaskList(current: TaskSummary[], next: TaskSummary[]): TaskSummary[] {
  if (sameTaskList(current, next)) return current;
  const currentById = new Map(current.map((task) => [task.id, task]));
  return next.map((task) => {
    const previous = currentById.get(task.id);
    return previous && sameTaskSummary(previous, task) ? previous : task;
  });
}

export function sameProjectList(a: ProjectDto[], b: ProjectDto[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (
      left.id !== right.id ||
      left.name !== right.name ||
      left.favorite !== right.favorite ||
      left.archived !== right.archived ||
      left.lastOpenedAt !== right.lastOpenedAt ||
      left.icon !== right.icon ||
      left.iconColor !== right.iconColor
    ) {
      return false;
    }
  }
  return true;
}

export function reorderProjectIds(
  ids: string[],
  sourceId: string,
  targetId: string,
  placement: ProjectDropPlacement = "before",
): string[] | null {
  if (sourceId === targetId) return null;
  const next = [...ids];
  const sourceIndex = next.indexOf(sourceId);
  const targetIndexBeforeMove = next.indexOf(targetId);
  if (sourceIndex < 0 || targetIndexBeforeMove < 0) return null;
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return null;
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (placement === "after" ? 1 : 0), 0, moved);
  return next;
}

export function sameHealth(a: HealthDto | null, b: HealthDto): boolean {
  if (!a) return false;
  return (
    a.ok === b.ok &&
    a.engineOk === b.engineOk &&
    a.version === b.version &&
    a.modelCount === b.modelCount &&
    a.error === b.error &&
    JSON.stringify(a.warnings ?? null) === JSON.stringify(b.warnings ?? null)
  );
}

const PROJECT_ICON_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon,.ico";
const MODE_KEY = "leafcodepi.mode";
const BUILD_COMMIT = process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT ?? "";
const BUILD_COMMIT_DATE = process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT_DATE ?? "";
const BUILD_COMMIT_DATE_LABEL = BUILD_COMMIT_DATE.slice(0, 16).replace("T", " ");
type AppMode = "code" | "bot";
type BotListFilter = "all" | "bots" | "rooms";
type WorkingCounts = Record<AppMode, number>;
type UnreadModes = Record<AppMode, boolean>;

function ModeSegment({ mode, onChange, workingCounts, unreadModes }: { mode: AppMode; onChange: (mode: AppMode) => void; workingCounts: WorkingCounts; unreadModes: UnreadModes }) {
  return <div className="mb-2 grid grid-cols-2 rounded-lg border border-border bg-surface-2 p-0.5">
    {(["code", "bot"] as const).map((item) => {
      const label = item === "code" ? "Code" : "Bot";
      const count = workingCounts[item];
      const unread = unreadModes[item];
      return <button key={item} type="button" aria-label={`${label}${count > 0 ? `（進行中${count}件）` : ""}${unread ? "（未読）" : ""}`} aria-pressed={mode === item} onClick={() => onChange(item)} className={cx("flex items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium", mode === item ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}>
        {item === "bot" ? (
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-[var(--brand)]">
            <circle cx="12" cy="12" r="12" fill="currentColor" />
            <path d="M8 7.5l.8 2.8M14.5 7l.8 2.8" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        ) : <CodeXml aria-hidden="true" className="h-4 w-4 shrink-0" />}
        <span>{label}</span>
        {unread && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        {count > 0 && <span aria-hidden="true" className="inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-white">{count}</span>}
      </button>;
    })}
  </div>;
}

function SidebarFooter({ health, onSettings }: { health: HealthDto | null; onSettings: () => void }) {
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [latestCommit, setLatestCommit] = useState<string | null>(null);
  const isOutdated = Boolean(BUILD_COMMIT && latestCommit && latestCommit !== BUILD_COMMIT);

  useEffect(() => {
    if (!BUILD_COMMIT) return;
    let active = true;
    const refreshLatestCommit = async () => {
      try {
        const info = await getJson<{ commit: string | null }>("/api/build-info");
        if (active) setLatestCommit(info.commit);
      } catch {
        // The build status is unknown when the local repository is unavailable.
      }
    };
    void refreshLatestCommit();
    const timer = window.setInterval(() => void refreshLatestCommit(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const restartWebUi = async () => {
    if (restartBusy || !window.confirm("WebUIを再起動しますか？")) return;
    setRestartBusy(true);
    setRestartError(null);
    try {
      await sendJson("/api/host/restart", { target: "webui" });
      window.dispatchEvent(new Event("leafcode:webui-restart"));
    } catch (error) {
      setRestartBusy(false);
      setRestartError(error instanceof Error ? error.message : "WebUIの再起動に失敗しました");
    }
  };

  return (
    <div className="shrink-0 border-t border-border p-2 pb-[env(safe-area-inset-bottom)]">
      <div className="mt-2">
        <CodexBarWidget />
      </div>
      <div className="mt-2">
        <SystemMonitorWidget />
      </div>
      <div className="mt-2 flex items-center justify-between gap-1">
        <div className="min-w-0 flex-1 px-2">
          <p className="truncate text-[11px] text-muted">
            {health?.engineOk ? `Pi ${health.version ?? ""} · モデル ${health.modelCount}` : "Pi 未接続"}
          </p>
          {BUILD_COMMIT && (
            <p
              className="truncate text-[10px] leading-tight text-muted"
              title={`ビルドコミット: ${BUILD_COMMIT}\nコミット日時: ${BUILD_COMMIT_DATE}`}
            >
              {`Build ${BUILD_COMMIT.slice(0, 8)}${BUILD_COMMIT_DATE_LABEL ? ` · ${BUILD_COMMIT_DATE_LABEL}` : ""}`}
            </p>
          )}
        </div>
        {isOutdated && latestCommit && (
          <span
            role="img"
            aria-label={`WebUIは最新版ではありません。最新コミット: ${latestCommit.slice(0, 12)}`}
            title={`WebUIは最新版ではありません。最新コミット: ${latestCommit.slice(0, 12)}。再起動で更新できます`}
            className="shrink-0"
          >
            <CircleAlert aria-hidden="true" className="h-3.5 w-3.5 text-warning" />
          </span>
        )}
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            aria-label="WebUIを再起動"
            title="WebUIを再起動"
            busy={restartBusy}
            onClick={() => void restartWebUi()}
          >
            {!restartBusy && <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          </Button>
          <Link
            href="/settings"
            aria-label="設定"
            onClick={(event) => {
              event.preventDefault();
              onSettings();
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
          >
            <Settings className="h-4 w-4" />
          </Link>
        </div>
      </div>
      {restartError && (
        <p role="alert" className="mt-1 truncate px-2 text-[10px] text-danger" title={restartError}>
          {restartError}
        </p>
      )}
    </div>
  );
}

const BotSidebarBody = memo(function BotSidebarBody({
  onClose,
  onChangeMode,
  onSettings,
  workingCounts,
  unreadModes,
  mdUp,
  collapsed,
  onCollapse,
  onExpand,
  onShowWorkingTasks,
  hasWorking,
  health,
}: {
  onClose: () => void;
  onChangeMode: (mode: AppMode) => void;
  onSettings: () => void;
  workingCounts: WorkingCounts;
  unreadModes: UnreadModes;
  health: HealthDto | null;
  onShowWorkingTasks: () => void;
  hasWorking: boolean;
  mdUp: boolean;
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const botSidebarPathRef = useRef(pathname);
  const botStatusFor = useBotStatusFor();
  const botSidebar = useSyncExternalStore(
    subscribeBotSidebar,
    getBotSidebarSnapshot,
    getBotSidebarServerSnapshot,
  );
  const { bots, rooms } = botSidebar;
  const loadError = botSidebar.error;
  const [query, setQuery] = useState("");
  const [listFilter, setListFilter] = useState<BotListFilter>("all");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  useEffect(() => {
    void refreshBotSidebar().catch(() => undefined);
    const onBotSidebarChanged = (event: Event) => {
      const refreshToken = (event as CustomEvent<{ refresh?: string }>).detail?.refresh;
      void refreshBotSidebar(refreshToken).catch(() => undefined);
    };
    window.addEventListener("webui:bot-sidebar-changed", onBotSidebarChanged);
    return () => {
      window.removeEventListener("webui:bot-sidebar-changed", onBotSidebarChanged);
    };
  }, []);
  useEffect(() => {
    if (botSidebarPathRef.current === pathname) return;
    botSidebarPathRef.current = pathname;
    void refreshBotSidebar().catch(() => undefined);
  }, [pathname]);
  async function createEntry(target: "bot" | "room") {
    if (busy) return;
    const name = window.prompt(target === "bot" ? "新しいBotの名前" : "新しいルームの名前")?.trim();
    if (!name) return;
    setCreateError(null);
    setBusy(true);
    try {
      if (target === "bot") {
        const r = await sendJson<{ bot: BotDto }>("/api/bots", { name });
        notifyBotSidebarChanged();
        router.push(`/bots/${r.bot.id}`);
      } else {
        const r = await sendJson<{ room: RoomDto }>("/api/bots/rooms", { name });
        notifyBotSidebarChanged();
        router.push(`/bots/rooms/${r.room.id}`);
      }
      onClose();
    } catch (error) {
      setCreateError(
        error instanceof Error && error.message
          ? error.message
          : "Botまたはルームの作成に失敗しました",
      );
    } finally {
      setBusy(false);
    }
  }
  const sidebarError = createError ?? loadError;
  const showWorkingTasks = () => {
    if (!mdUp) return;
    onShowWorkingTasks();
  };
  if (collapsed) {
    return (
      <div className="flex h-full w-full flex-col items-center bg-surface">
        <div className="flex h-14 w-full items-center justify-center border-b border-border">
          <button
            type="button"
            aria-label="サイドバーを展開"
            onClick={onExpand}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-surface-2"
          >
            <Menu className="h-5 w-5 text-muted" />
          </button>
        </div>
        {sidebarError && (
          <p role="alert" className="w-full break-words px-1 py-2 text-center text-[10px] text-danger">
            {sidebarError}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <ul className="flex flex-col items-center gap-3">
            {rooms.map((room) => {
              const href = `/bots/rooms/${encodeURIComponent(room.id)}`;
              const active = pathname === `/bots/rooms/${room.id}`;
              return (
                <li key={room.id}>
                  <button
                    type="button"
                    title={room.name}
                    aria-label={`${room.name}を開く`}
                    aria-current={active ? "page" : undefined}
                    draggable
                    onDragStart={(event) => setTaskDragData(event.dataTransfer, href)}
                    onClick={() => router.push(href)}
                    className={cx(
                      "group relative inline-flex h-12 w-12 items-center justify-center rounded-xl p-1 hover:bg-surface-2",
                      active && "bg-surface-2 ring-1 ring-inset ring-accent/20",
                    )}
                  >
                    <span className="flex h-full w-full items-center justify-center rounded-full bg-success-bg text-sm text-success transition-transform group-hover:scale-105">
                      #
                    </span>
                    {!active && hasUnread(room.lastMessageAt, getLastReadAt("room", room.id)) && (
                      <span
                        aria-label="未読"
                        className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent"
                      />
                    )}
                  </button>
                </li>
              );
            })}
            {bots.map((bot) => {
              const href = `/bots/${encodeURIComponent(bot.id)}`;
              const active = pathname === `/bots/${bot.id}`;
              return (
                <li key={bot.id}>
                  <button
                    type="button"
                    title={bot.name}
                    aria-label={`${bot.name}を開く`}
                    aria-current={active ? "page" : undefined}
                    draggable
                    onDragStart={(event) => setTaskDragData(event.dataTransfer, href)}
                    onClick={() => router.push(href)}
                    className={cx(
                      "group relative inline-flex h-12 w-12 items-center justify-center rounded-xl p-1 hover:bg-surface-2",
                      active && "bg-surface-2 ring-1 ring-inset ring-accent/20",
                    )}
                  >
                    <span className="relative"><BotAvatar size={40} {...bot} active={bot.codeInProgress === true || botStatusFor(`/bots/${encodeURIComponent(bot.id)}`) === "working"} />{bot.codeSessionCount ? <span aria-label={`Codeセッション${bot.codeSessionCount}件`} title={`Codeセッション${bot.codeSessionCount}件`} className="absolute -bottom-1 -right-1 inline-flex min-w-4 items-center justify-center rounded-full border-2 border-surface bg-accent px-1 text-[10px] font-semibold leading-3 text-white">{bot.codeSessionCount}</span> : null}</span>
                    {!active && hasUnread(bot.lastMessageAt, getLastReadAt("bot", bot.id)) && (
                      <span
                        aria-label="未読"
                        className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex w-full flex-col items-center gap-1 border-t border-border py-2">
          <WorkingTasksButton hasWorking={hasWorking} mdUp={mdUp} onClick={showWorkingTasks} />
          <button
            type="button"
            aria-label="Botを追加"
            title="Botを追加"
            disabled={busy}
            onClick={() => void createEntry("bot")}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="ルームを追加"
            title="ルームを追加"
            disabled={busy}
            onClick={() => void createEntry("room")}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
          >
            <Users className="h-4 w-4" />
          </button>
          <Link
            href="/settings"
            aria-label="設定"
            onClick={(event) => {
              event.preventDefault();
              onSettings();
            }}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2"
          >
            <Settings className="h-4 w-4" />
          </Link>
        </div>
      </div>
    );
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleBots = listFilter === "rooms" ? [] : (normalizedQuery ? bots.filter((bot) => bot.name.toLocaleLowerCase().includes(normalizedQuery)) : bots);
  const visibleRooms = listFilter === "bots" ? [] : (normalizedQuery ? rooms.filter((room) => room.name.toLocaleLowerCase().includes(normalizedQuery)) : rooms);
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          aria-label={mdUp ? "サイドバーを折りたたむ" : "メニューを閉じる"}
          onClick={() => { if (mdUp) onCollapse(); else onClose(); }}
          className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-surface-2 md:h-8 md:w-8"
        >
          {mdUp ? <Menu className="h-5 w-5 text-muted" /> : <X className="h-5 w-5 text-muted" />}
        </button>
        <Link href="/bots" onClick={onClose} className="flex min-w-0 items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="h-6 w-6 rounded-[5px]" />
          <span className="truncate text-sm font-semibold">LeafCodePi</span>
        </Link>
        <button
          type="button"
          aria-label="Botを追加"
          title="Botを追加"
          onClick={() => void createEntry("bot")}
          disabled={busy}
          className="ml-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="ルームを追加"
          title="ルームを追加"
          onClick={() => void createEntry("room")}
          disabled={busy}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
        >
          <Users className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <ModeSegment mode="bot" onChange={onChangeMode} workingCounts={workingCounts} unreadModes={unreadModes} />
        <label className="mb-2 flex h-9 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-xs text-muted focus-within:border-accent"><Search className="h-3.5 w-3.5 shrink-0" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={"\u30dc\u30c3\u30c8\u3084\u30eb\u30fc\u30e0\u3092\u691c\u7d22"} aria-label={"\u30dc\u30c3\u30c8\u3084\u30eb\u30fc\u30e0\u3092\u691c\u7d22"} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" /></label>
        {sidebarError && <p role="alert" className="mb-2 rounded-lg border border-danger/30 bg-danger-bg px-2.5 py-2 text-xs text-danger">{sidebarError}</p>}
        <div className="mb-2 flex gap-1 px-0.5" role="group" aria-label={"\u8868\u793a\u5bfe\u8c61"}>{([['all', '\u3059\u3079\u3066'], ['bots', 'Bot'], ['rooms', '\u30eb\u30fc\u30e0']] as const).map(([value, label]) => <button key={value} type="button" aria-label={value === "bots" ? "Bot filter" : value === "rooms" ? "Room filter" : "All filter"} aria-pressed={listFilter === value} onClick={() => setListFilter(value)} className={`rounded-full px-2.5 py-1 text-[11px] ${listFilter === value ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-surface-2"}`}>{label}</button>)}</div>
        <div className="flex items-center justify-between px-2 py-1"><span className="text-xs font-medium text-muted">ルーム</span><Link href="/bots" onClick={onClose} className="text-xs text-accent">すべて</Link></div>
        <div className="mt-1 space-y-1">{visibleRooms.map((room) => <button key={room.id} type="button" draggable={mdUp} onDragStart={(event) => setTaskDragData(event.dataTransfer, `/bots/rooms/${encodeURIComponent(room.id)}`)} onClick={() => { router.push(`/bots/rooms/${encodeURIComponent(room.id)}`); onClose(); }} aria-current={pathname === `/bots/rooms/${room.id}` ? "page" : undefined} className={`relative flex w-full min-w-0 items-center gap-2 rounded-xl px-2.5 py-1 text-left hover:bg-surface-2 ${pathname === `/bots/rooms/${room.id}` ? "bg-surface-2 ring-1 ring-inset ring-accent/20" : ""}`}><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success-bg text-xs text-success">#</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium leading-tight">{room.name}</span><span className="block truncate text-xs leading-tight text-muted">{room.lastMessageSummary ?? "\u30e1\u30c3\u30bb\u30fc\u30b8\u306a\u3057"}</span></span>{pathname !== `/bots/rooms/${room.id}` && hasUnread(room.lastMessageAt, getLastReadAt("room", room.id)) && <span aria-label={"\u672a\u8aad"} title={"\u672a\u8aad"} className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}<span className="shrink-0 self-start pt-0.5 text-xs text-muted">{timeAgo(room.lastMessageAt ?? room.updatedAt)}</span></button>)}{visibleRooms.length === 0 && <p className="px-2 py-2 text-xs text-muted">ルームはありません</p>}</div>
        <div className="mt-2 flex items-center justify-between bg-bg px-2 py-1"><span className="text-xs font-medium text-muted">Bot</span><Link href="/bots" onClick={onClose} className="text-xs text-accent">すべて</Link></div>
        <div className="mt-1 space-y-1">{visibleBots.map((bot) => <button key={bot.id} type="button" draggable={mdUp} onDragStart={(event) => setTaskDragData(event.dataTransfer, `/bots/${encodeURIComponent(bot.id)}`)} onClick={() => { router.push(`/bots/${encodeURIComponent(bot.id)}`); onClose(); }} aria-current={pathname === `/bots/${bot.id}` ? "page" : undefined} className={`relative flex w-full min-w-0 items-center gap-2 rounded-xl px-2.5 py-1 text-left hover:bg-surface-2 ${pathname === `/bots/${bot.id}` ? "bg-surface-2 ring-1 ring-inset ring-accent/20" : ""}`}><span className="relative"><BotAvatar size={32} {...bot} active={bot.codeInProgress === true || botStatusFor(`/bots/${encodeURIComponent(bot.id)}`) === "working"} />{bot.codeSessionCount ? <span aria-label={`Codeセッション${bot.codeSessionCount}件`} title={`Codeセッション${bot.codeSessionCount}件`} className="absolute -bottom-1 -right-1 inline-flex min-w-4 items-center justify-center rounded-full border-2 border-surface bg-accent px-1 text-[10px] font-semibold leading-3 text-white">{bot.codeSessionCount}</span> : null}</span><span aria-label={bot.enabled ? "\u6709\u52b9" : "\u7121\u52b9"} title={bot.enabled ? "\u6709\u52b9" : "\u7121\u52b9"} className="sr-only" /><span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-1.5"><span className="min-w-0 truncate text-sm font-medium leading-tight">{bot.name}</span>{bot.label?.trim() && <span title={bot.label} className="max-w-28 shrink-0 truncate rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] font-normal leading-4 text-muted">{bot.label}</span>}</span><span className="block truncate text-xs leading-tight text-muted">{bot.lastMessageSummary ?? "\u30e1\u30c3\u30bb\u30fc\u30b8\u306a\u3057"}</span></span>{pathname !== `/bots/${bot.id}` && hasUnread(bot.lastMessageAt, getLastReadAt("bot", bot.id)) && <span aria-label={"\u672a\u8aad"} title={"\u672a\u8aad"} className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}<span className="shrink-0 self-start pt-0.5 text-xs text-muted">{bot.lastMessageAt ? timeAgo(bot.lastMessageAt) : ""}</span></button>)}{visibleBots.length === 0 && <p className="px-2 py-2 text-xs text-muted">Botはありません</p>}</div>
      </div>
      <SidebarFooter health={health} onSettings={onSettings} />
    </div>
  );
});
const ICON_PICKER_CLASS = "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md text-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-primary";

function ProjectIconPicker({
  project,
  className,
  iconClassName,
  onFileChange,
  role,
  onOpenHost,
  hostBusy = false,
}: {
  project: Pick<ProjectDto, "id" | "name" | "icon" | "iconColor">;
  className?: string;
  iconClassName?: string;
  onFileChange: (file: File | null) => void;
  role?: "menuitem";
  /** 指定時はブラウザの file input ではなくホストPCのネイティブダイアログで選ぶ。 */
  onOpenHost?: (() => void) | undefined;
  hostBusy?: boolean;
}) {
  const label = `${project.name}のアイコンを設定`;
  const icon = <ProjectIcon project={project} className={cx(iconClassName, !project.icon && "border")} />;
  if (onOpenHost) {
    return (
      <button
        type="button"
        role={role}
        title={label}
        aria-label={label}
        disabled={hostBusy}
        onClick={onOpenHost}
        className={cx(ICON_PICKER_CLASS, "disabled:cursor-default disabled:opacity-50", className)}
      >
        {icon}
      </button>
    );
  }
  return (
    <label role={role} title={label} className={cx(ICON_PICKER_CLASS, className)}>
      {icon}
      <input
        type="file"
        aria-label={label}
        accept={PROJECT_ICON_ACCEPT}
        className="sr-only"
        onChange={(event) => {
          onFileChange(event.target.files?.[0] ?? null);
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

function isCodeTask(task: TaskSummary): boolean {
  return task.kind !== "bot";
}

export function countRunningTasks(tasks: TaskSummary[]): number {
  let count = 0;
  for (const task of tasks) {
    if (task.status === "working") count += 1;
  }
  return count;
}

function hasUnreadTask(task: TaskSummary, activeTaskId: string | null): boolean {
  return task.status !== "working" && task.id !== activeTaskId
    && hasUnread(task.updatedAt, getLastReadAt("task", task.id));
}

function compareIsoUpdatedAtDescending(a: string, b: string): number {
  // Store timestamps use toISOString(), so codepoint order matches chronological order.
  return a === b ? 0 : a > b ? -1 : 1;
}

function sidebarTaskComparator(pinnedTaskIds?: ReadonlySet<string>) {
  return (a: TaskSummary, b: TaskSummary) =>
    Number(pinnedTaskIds?.has(b.id)) - Number(pinnedTaskIds?.has(a.id)) ||
    Number(b.status === "working") - Number(a.status === "working") ||
    compareIsoUpdatedAtDescending(a.updatedAt, b.updatedAt);
}

function sortTasksForSidebarInPlace(
  tasks: TaskSummary[],
  pinnedTaskIds?: ReadonlySet<string>,
  compare = sidebarTaskComparator(pinnedTaskIds),
): void {
  if (tasks.length < 3) {
    tasks.sort(compare);
    return;
  }
  const sorted = tasks.map((task, index) => ({
    task,
    index,
    rank: (pinnedTaskIds?.has(task.id) ? 2 : 0) + (task.status === "working" ? 1 : 0),
  }));
  sorted.sort((a, b) =>
    b.rank - a.rank ||
    compareIsoUpdatedAtDescending(a.task.updatedAt, b.task.updatedAt) ||
    a.index - b.index,
  );
  for (let index = 0; index < tasks.length; index += 1) {
    tasks[index] = sorted[index]!.task;
  }
}

/** ピン留めを優先し、その中でも従来どおり進行中・更新日時順に表示する。 */
export function tasksForSidebar(
  tasks: TaskSummary[],
  pinnedTaskIds?: ReadonlySet<string>,
): TaskSummary[] {
  const sorted = [...tasks];
  sortTasksForSidebarInPlace(sorted, pinnedTaskIds);
  return sorted;
}

/** プロジェクト内で更新日時が最新の進行中タスクを返す。 */
export function latestWorkingTask(tasks: TaskSummary[], projectId: string): TaskSummary | null {
  let latest: TaskSummary | null = null;
  for (const task of tasks) {
    if (task.projectId !== projectId || task.status !== "working") continue;
    if (!latest || task.updatedAt.localeCompare(latest.updatedAt) > 0) latest = task;
  }
  return latest;
}

function promotionBlocked(task: TaskSummary): boolean {
  return task.status === "working" || isGoalLoopLiveStatus(task.goalLoopSummary?.status);
}

function TodoProgressBar({
  task,
  className,
}: {
  task: Pick<TaskSummary, "title" | "todoProgress">;
  className?: string;
}) {
  const progress = task.todoProgress;
  if (!progress || !Number.isFinite(progress.total) || progress.total <= 0) return null;

  const total = Math.trunc(progress.total);
  if (total <= 0) return null;
  const completed = Number.isFinite(progress.completed)
    ? Math.min(total, Math.max(0, Math.trunc(progress.completed)))
    : 0;
  const percent = Math.round((completed / total) * 100);
  const valueText = `ToDo ${completed}/${total}件完了（${percent}%）`;

  return (
    <div className={cx("min-w-0", className)}>
      <div
        role="progressbar"
        aria-label={`${task.title}のToDo進捗`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
        aria-valuetext={valueText}
        title={valueText}
        className="h-1 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className={cx("h-full rounded-full transition-[width]", percent === 100 ? "bg-success" : "bg-working")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function GoalLoopProgressBar({
  task,
  className,
}: {
  task: Pick<TaskSummary, "title" | "goalLoopSummary">;
  className?: string;
}) {
  const loop = task.goalLoopSummary;
  if (!loop || !isGoalLoopLiveStatus(loop.status)) return null;

  const turnCount = Number.isFinite(loop.turnCount) ? Math.max(0, Math.trunc(loop.turnCount)) : 0;
  const total = Number.isFinite(loop.maxTurns) ? Math.max(0, Math.trunc(loop.maxTurns)) : 0;
  const turn = loop.status === "queued" ? turnCount + 1 : turnCount;
  const shownTurn = total > 0 ? Math.min(turn, total) : turn;
  const percent = total > 0 ? Math.round((shownTurn / total) * 100) : null;
  const valueText =
    percent === null
      ? `ループ ${shownTurn}ターン実行中（無制限）`
      : `ループ ${shownTurn}/${total}ターン（${percent}%）`;

  return (
    <div className={cx("min-w-0", className)}>
      <div
        role="progressbar"
        aria-label={`${task.title}のループ進捗`}
        aria-valuemin={percent === null ? undefined : 0}
        aria-valuemax={percent === null ? undefined : 100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={valueText}
        title={valueText}
        className="h-1 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className={cx(
            "h-full rounded-full bg-working transition-[width]",
            percent === null && "animate-pulse",
          )}
          style={{ width: `${percent ?? 35}%` }}
        />
      </div>
    </div>
  );
}

export const TaskProgressBar = memo(function TaskProgressBar({
  task,
  className,
}: {
  task: Pick<TaskSummary, "title" | "todoProgress" | "goalLoopSummary">;
  className?: string;
}) {
  return task.goalLoopSummary && isGoalLoopLiveStatus(task.goalLoopSummary.status) ? (
    <GoalLoopProgressBar task={task} className={className} />
  ) : (
    <TodoProgressBar task={task} className={className} />
  );
});

export const TaskActivityIcon = memo(function TaskActivityIcon({
  task,
  bot,
  unread = false,
}: {
  task: Pick<TaskSummary, "status" | "botId" | "supervisorBotId">;
  bot?: BotFace & { name: string };
  unread?: boolean;
}) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      {task.status === "working" ? (
        bot ? (
          <BotAvatar size={16} {...bot} active />
        ) : (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-working" />
        )
      ) : (
        <span
          aria-hidden="true"
          className={cx(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            task.status === "error" ? "bg-danger" : unread ? "bg-accent" : "bg-faint",
          )}
        />
      )}
    </span>
  );
});

export const SidebarTaskRow = memo(function SidebarTaskRow({
  task,
  active,
  bot,
  pinned,
  unread = false,
  mdUp,
  actionBusy,
  onOpenTask,
  onPinTask,
  onPromoteTask,
  onArchiveTask,
  onDragStart,
}: {
  task: TaskSummary;
  active: boolean;
  bot?: BotFace & { name: string };
  pinned: boolean;
  unread?: boolean;
  mdUp: boolean;
  actionBusy: boolean;
  onOpenTask: (taskId: string) => void;
  onPinTask: (taskId: string) => void;
  onPromoteTask: (task: TaskSummary) => void;
  onArchiveTask: (taskId: string) => void;
  onDragStart: (event: React.DragEvent<HTMLButtonElement>, taskId: string) => void;
}) {
  const cannotPromote = promotionBlocked(task);
  // 展開したプロジェクトは数百行を一度に描画するため、画面外の行は layout/paint をスキップさせる。
  // content-visibility の paint containment でフォーカスリングが欠けるので、行内のボタンは内側へ寄せる。
  // contain-intrinsic-size のフォールバックは実測の行高（約53px）に合わせ、未描画行の高さズレを防ぐ。
  return (
    <li className="group rounded-lg [content-visibility:auto] [contain-intrinsic-size:auto_3.25rem] [&_button:focus-visible]:outline-offset-[-2px]">
      <SwipeArchiveRow label={`「${task.title}」をアーカイブ`} onArchive={() => onArchiveTask(task.id)}>
      <div className="flex items-center">
        <button
          type="button"
          draggable={mdUp}
          onDragStart={(event) => onDragStart(event, task.id)}
          onClick={() => onOpenTask(task.id)}
          className={cx(
            "flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left md:min-h-8",
            active ? "bg-surface-3 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
          )}
        >
          <TaskActivityIcon task={task} bot={bot} unread={unread} />
          <span className="relative top-0.5 flex min-w-0 flex-1 flex-col items-start">
            <span className="w-full truncate text-xs font-medium">{task.title}</span>
            <span className="flex w-full min-w-0 items-center gap-1">
              <span className="flex w-11 shrink-0 items-center">
                <SessionLabelBadge labelId={task.label} className="w-full truncate text-center" />
              </span>
              <span className="w-16 shrink-0 truncate text-[10px] text-muted">{timeAgo(task.updatedAt)}</span>
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={pinned ? `「${task.title}」のピン留めを解除` : `「${task.title}」をピン留め`}
          title={pinned ? "ピン留めを解除" : "タスクをピン留め"}
          onClick={() => onPinTask(task.id)}
          className={cx(
            "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-surface-2 md:h-6 md:w-6",
            pinned ? "text-accent" : "text-muted hover:text-text",
          )}
        >
          <Pin className={cx("h-3 w-3", pinned && "fill-current")} />
        </button>
        {task.projectId === null && (
          <button
            type="button"
            aria-label={cannotPromote ? `「${task.title}」は実行中のため昇格できません` : `「${task.title}」をプロジェクトへ昇格`}
            title={cannotPromote ? "実行中のタスクは昇格できません" : "プロジェクトへ昇格"}
            disabled={actionBusy || cannotPromote}
            onClick={() => onPromoteTask(task)}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40 md:h-6 md:w-6"
          >
            <FolderUp className="h-3 w-3" />
          </button>
        )}
      </div>
      <TaskProgressBar task={task} className="mx-8 pb-1.5 md:mx-7" />
      </SwipeArchiveRow>
    </li>
  );
});

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveExpanded(ids: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

function loadLegacyPinnedTaskIds(): Set<string> {
  try {
    const raw = localStorage.getItem(LEGACY_PINNED_TASKS_KEY);
    const ids = parsePinnedTaskIds(raw);
    return new Set(ids ?? []);
  } catch {
    return new Set();
  }
}

function clearLegacyPinnedTaskIds(): void {
  try {
    localStorage.removeItem(LEGACY_PINNED_TASKS_KEY);
  } catch {
    /* ignore */
  }
}

function loadProjectOrder(): string[] {
  try {
    const raw = localStorage.getItem(PROJECT_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return [];
}

function saveProjectOrder(ids: string[]): void {
  try {
    localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
}

function projectDragIdFromDataTransfer(dataTransfer: DataTransfer): string | null {
  try {
    return dataTransfer.getData(PROJECT_DRAG_MIME) || null;
  } catch {
    return null;
  }
}

function subscribeMdUp(onChange: () => void) {
  const mq = window.matchMedia("(min-width: 768px)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useIsMdUp(): boolean {
  return useSyncExternalStore(
    subscribeMdUp,
    () => window.matchMedia("(min-width: 768px)").matches,
    () => true,
  );
}

const PROJECT_ICON_COLOR_OPTIONS = [
  { value: "red", label: "赤", className: "bg-danger" },
  { value: "orange", label: "橙", className: "bg-orange-500" },
  { value: "yellow", label: "黄", className: "bg-warning" },
  { value: "lime", label: "黄緑", className: "bg-lime-500" },
  { value: "green", label: "緑", className: "bg-success" },
  { value: "emerald", label: "翠", className: "bg-emerald-500" },
  { value: "teal", label: "青緑", className: "bg-teal-500" },
  { value: "cyan", label: "水色", className: "bg-cyan-500" },
  { value: "blue", label: "青", className: "bg-accent" },
  { value: "indigo", label: "藍", className: "bg-indigo-500" },
  { value: "purple", label: "紫", className: "bg-purple-500" },
  { value: "pink", label: "桃", className: "bg-pink-500" },
] as const satisfies readonly { value: ProjectIconColor; label: string; className: string }[];

function PromoteTaskDialog({
  task,
  onClose,
  onDone,
}: {
  task: TaskSummary;
  onClose: () => void;
  onDone: (warning?: string) => void;
}) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  async function submit() {
    const destinationPath = path.trim();
    if (!destinationPath || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ warning?: string }>(
        `/api/tasks/${encodeURIComponent(task.id)}/promote`,
        { destinationPath },
      );
      onDone(result.warning);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "プロジェクトへの昇格に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-3 backdrop-blur-[2px] sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="promote-task-title"
        className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-2xl"
      >
        <div className="border-b border-border px-4 py-3 sm:px-5">
          <h2 id="promote-task-title" className="text-sm font-semibold">プロジェクトへ昇格</h2>
          <p className="mt-1 truncate text-xs text-muted" title={task.title}>{task.title}</p>
        </div>
        <div className="space-y-3 p-4 sm:p-5">
          <p className="text-xs leading-5 text-muted">
            作業フォルダーを指定先へ移動し、通常プロジェクトとして登録します。移動先は空のフォルダーにしてください。
          </p>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              aria-label="移動先フォルダーのパス"
              placeholder="C:\\path\\to\\project"
              className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 font-mono text-xs outline-none placeholder:text-faint focus:border-accent"
            />
            <AddProjectButton
              label="参照"
              onSelect={setPath}
              buttonVariant="secondary"
              buttonSize="sm"
              dialogZIndex={120}
            />
          </div>
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3 sm:px-5">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button variant="primary" size="sm" onClick={() => void submit()} busy={busy} disabled={!path.trim()}>
            移動して登録
          </Button>
        </div>
      </div>
    </div>
  );
}

/** ApiError の status（モックのスタブやネットワーク例外では undefined）。 */
function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

function ProjectSettingsDialog({
  project,
  onClose,
  hostPlatform,
  onSetIcon,
  onSetIconData,
  onClearIcon,
  onSetIconColor,
  onMigrate,
  onMarkAllRead,
  externalError,
}: {
  project: ProjectDto;
  onClose: () => void;
  /** ホストPCのプラットフォーム（ネイティブダイアログの可否）。 */
  hostPlatform: string | undefined;
  onSetIcon: (file: File | null) => void;
  onSetIconData: (icon: string) => void;
  onClearIcon: () => void;
  onSetIconColor: (color: ProjectDto["iconColor"]) => void;
  onMigrate: (destinationPath: string) => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  externalError: string | null;
}) {
  const [destinationPath, setDestinationPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [markReadBusy, setMarkReadBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** ホスト制御面（loopback）に到達できるクライアントか。判定は explorer と同じ探索を使う。 */
  const [hostTarget, setHostTarget] = useState<ExplorerTarget | null>(null);
  /** ネイティブダイアログが失敗したらブラウザの file input へ戻す。 */
  const [iconHostFailed, setIconHostFailed] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const hostIconPick = !iconHostFailed && hostTarget !== null;

  useEffect(() => {
    if (hostPlatform !== "win32") return;
    setHostTarget(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 1_500);
    void discoverExplorerTarget(project.id, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setHostTarget(next);
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [hostPlatform, project.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  async function markAllRead() {
    if (busy || markReadBusy) return;
    setMarkReadBusy(true);
    setError(null);
    try {
      await onMarkAllRead();
    } catch (err) {
      setError(err instanceof Error ? err.message : "既読化に失敗しました");
    } finally {
      setMarkReadBusy(false);
    }
  }

  async function migrate() {
    const destination = destinationPath.trim();
    if (!destination || busy) return;
    if (!window.confirm(`「${project.name}」を指定先へ移動しますか？`)) return;
    setBusy(true);
    setError(null);
    try {
      await onMigrate(destination);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "プロジェクトの移動に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  /** ホストPCのネイティブダイアログをリポジトリ（rootPath）起点で開く。 */
  async function pickIconFromHost() {
    if (busy || iconBusy) return;
    setIconBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ icon?: string; cancelled?: boolean }>(
        "/api/browse/icon",
        { path: project.rootPath },
        "POST",
        { timeoutMs: 135_000 },
      );
      if (result.icon) onSetIconData(result.icon);
    } catch (err) {
      // 画像として使えない選択（400）はネイティブのまま、ホスト側の失敗だけ従来の file input へ戻す。
      if (errorStatus(err) !== 400) setIconHostFailed(true);
      setError(err instanceof Error ? err.message : "アイコン選択に失敗しました");
    } finally {
      setIconBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-3 backdrop-blur-[2px] sm:p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="project-settings-title" className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 id="project-settings-title" className="text-sm font-semibold">プロジェクト設定</h2>
            <p className="mt-1 truncate text-xs text-muted" title={project.name}>{project.name}</p>
          </div>
          <button type="button" aria-label="閉じる" onClick={onClose} disabled={busy} className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-5 p-4 sm:p-5">
          <section>
            <h3 className="text-xs font-semibold text-text">アイコン</h3>
            <div className="mt-2 flex items-center gap-3">
              <ProjectIconPicker
                project={project}
                className="h-11 w-11 hover:bg-surface-2"
                iconClassName="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-medium"
                onFileChange={onSetIcon}
                onOpenHost={hostIconPick ? () => void pickIconFromHost() : undefined}
                hostBusy={iconBusy}
              />
              <span className="flex-1 text-xs text-muted">画像またはEXEを指定するか、色を選択してください。</span>
              {project.icon && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={onClearIcon}>画像を削除</Button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="アイコンの色">
              {PROJECT_ICON_COLOR_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-label={`${project.name}のアイコン色を${option.label}に変更`}
                  title={option.label}
                  aria-pressed={project.iconColor === option.value}
                  disabled={busy}
                  onClick={() => onSetIconColor(option.value)}
                  className={cx(
                    "h-7 w-7 rounded-full border-2 border-surface shadow-sm ring-1 ring-border transition-transform hover:scale-110 disabled:cursor-not-allowed disabled:opacity-40",
                    option.className,
                    project.iconColor === option.value && "ring-2 ring-primary ring-offset-2 ring-offset-surface",
                  )}
                />
              ))}
            </div>
          </section>
          <section className="border-t border-border pt-4">
            <h3 className="text-xs font-semibold text-text">未読</h3>
            <p className="mt-1 text-xs leading-5 text-muted">進行中以外のセッションをすべて既読にします。</p>
            <Button variant="ghost" size="sm" busy={markReadBusy} disabled={busy || markReadBusy} onClick={() => void markAllRead()} aria-label={`${project.name}のセッションをすべて既読にする`} className="mt-3">
              すべて既読にする
            </Button>
          </section>
          <section className="border-t border-border pt-4">
            <h3 className="text-xs font-semibold text-text">プロジェクトを移動</h3>
            <p className="mt-1 text-xs leading-5 text-muted">作業フォルダーと保存済みセッションを移動します。移動先は空のフォルダーにしてください。実行中のタスクがある場合は移動できません。</p>
            <div className="mt-3 flex gap-2">
              <input
                value={destinationPath}
                onChange={(event) => setDestinationPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void migrate();
                  }
                }}
                aria-label="移動先フォルダーのパス"
                placeholder="C:\\path\\to\\project"
                className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 font-mono text-xs outline-none placeholder:text-faint focus:border-accent"
              />
              <AddProjectButton label="参照" onSelect={setDestinationPath} buttonVariant="secondary" buttonSize="sm" dialogZIndex={120} />
            </div>
          </section>
          {(error ?? externalError) && <p role="alert" className="text-xs text-danger">{error ?? externalError}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3 sm:px-5">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button variant="primary" size="sm" onClick={() => void migrate()} busy={busy} disabled={!destinationPath.trim()}>移動</Button>
        </div>
      </div>
    </div>
  );
}

type SidebarProps = {
  mobileOpen: boolean;
  onClose: () => void;
};

type SidebarPaneProps = {
  paneActiveTaskId: string | null;
  paneMdUp: boolean;
  splitHostEnabled: boolean;
  retargetToUrl: (taskId: string) => void;
  dispatch: (action: TaskPanesAction) => void;
};

const SidebarView = memo(function SidebarView({
  mobileOpen,
  onClose,
  paneActiveTaskId,
  paneMdUp,
  splitHostEnabled,
  retargetToUrl,
  dispatch,
}: SidebarProps & SidebarPaneProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mode, setMode] = useState<AppMode>("code");
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const [query, setQuery] = useState("");
  const mdUp = useIsMdUp();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<ProjectDto[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<TaskSummary[]>([]);
  const [bots, setBots] = useState<BotDto[]>([]);
  const [health, setHealth] = useState<HealthDto | null>(null);
  const botSidebar = useSyncExternalStore(
    subscribeBotSidebar,
    getBotSidebarSnapshot,
    getBotSidebarServerSnapshot,
  );
  const botStatusFor = useBotStatusFor();
  useSyncExternalStore(subscribeUnreadState, getUnreadSnapshot, getUnreadSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  /** ドラッグ中のみ端をカーソルへ追従させる幅（離したら null へ戻して吸着させる）。 */
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [hoverCapable, setHoverCapable] = useState(
    () =>
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia(HOVER_QUERY).matches,
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [projectOrder, setProjectOrder] = useState<string[]>(() => loadProjectOrder());
  const [pinnedTaskIds, setPinnedTaskIds] = useState<Set<string>>(new Set());
  const pinnedTaskIdsRef = useRef(new Set<string>());
  const pinnedPendingTogglesRef = useRef<string[]>([]);
  const pinnedLoadedRef = useRef(false);
  const pinnedWriteQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [archivedProjectsExpanded, setArchivedProjectsExpanded] = useState(false);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null);
  const [keyboardDraggedProjectId, setKeyboardDraggedProjectId] = useState<string | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [projectTaskMenu, setProjectTaskMenu] = useState<ProjectTaskMenuState | null>(null);
  const [promotionTask, setPromotionTask] = useState<TaskSummary | null>(null);
  const [projectSettingsProject, setProjectSettingsProject] = useState<ProjectDto | null>(null);
  const [railWidget, setRailWidget] = useState<RailWidget | null>(null);
  const [railWidgetPos, setRailWidgetPos] = useState({ bottom: 0, left: 0 });
  const taskDragActiveRef = useRef(false);
  const refreshGenRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const projectTaskMenuHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectTaskMenuRef = useRef<HTMLDivElement | null>(null);
  const railWidgetHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const railWidgetRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (unreadOnly = false, modeOverride: AppMode = mode) => {
    void hydrateLastReadState();
    // Avoid piling up four JSON requests per poll while a slow host is still responding.
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
    const gen = ++refreshGenRef.current;
    // アーカイブ済みセッションは展開時だけ取得する。通常表示の定期更新から
    // 履歴全件の転送・Todo進捗集計を外し、表示中のセッションを優先する。
    const includeArchivedTasks = archivedExpanded && !unreadOnly;
    const [projectRes, taskRes, healthRes, botRes] = await Promise.allSettled([
      unreadOnly ? Promise.resolve(null) : getJson<{ projects: ProjectDto[] }>("/api/projects?archived=1"),
      getJson<{ tasks: TaskSummary[] }>(
        includeArchivedTasks ? "/api/tasks?archived=1&kind=all" : "/api/tasks?kind=all",
      ),
      unreadOnly ? Promise.resolve(null) : getJson<HealthDto>("/api/health"),
      modeOverride === "code" && !unreadOnly
        ? getJson<{ bots: BotDto[] }>("/api/bots")
        : Promise.resolve(null),
    ]);
    // Drop stale responses so a slow poll cannot overwrite a newer refresh.
    if (gen !== refreshGenRef.current) return;
    if (taskDragActiveRef.current) return;
    const dataError = projectRes.status === "rejected"
      ? projectRes.reason
      : taskRes.status === "rejected"
        ? taskRes.reason
        : null;
    setRefreshError(
      dataError instanceof Error && dataError.message
        ? dataError.message
        : dataError
          ? "サイドバーの読み込みに失敗しました"
          : null,
    );
    if (projectRes.status === "fulfilled" && projectRes.value) {
      // 実質不変なら前回の参照を維持し、Sidebar の不要な再レンダーを避ける。
      const nextProjects = projectRes.value.projects.filter((project) => !project.archived);
      const nextArchived = projectRes.value.projects.filter((project) => project.archived);
      setProjects((current) =>
        sameProjectList(current, nextProjects) ? current : nextProjects,
      );
      setArchivedProjects((current) =>
        sameProjectList(current, nextArchived) ? current : nextArchived,
      );
    }
    if (taskRes.status === "fulfilled") {
      const nextTasks = taskRes.value.tasks.filter((task) => task.status !== "archived");
      setTasks((current) => stabilizeTaskList(current, nextTasks));
      if (includeArchivedTasks) {
        const nextArchivedTasks = taskRes.value.tasks.filter((task) => task.status === "archived");
        setArchivedTasks((current) => stabilizeTaskList(current, nextArchivedTasks));
      }
    }
    if (healthRes.status === "fulfilled" && healthRes.value) {
      const nextHealth = healthRes.value;
      setHealth((current) => (sameHealth(current, nextHealth) ? current : nextHealth));
    }
    if (botRes.status === "fulfilled" && botRes.value) {
      const nextBots = botRes.value.bots;
      setBots((current) => {
        const unchanged = current.length === nextBots.length && current.every((bot, index) => {
          const next = nextBots[index];
          return next && bot.id === next.id && bot.name === next.name && bot.avatarColor === next.avatarColor && bot.avatarShape === next.avatarShape && bot.avatarImage === next.avatarImage
            && bot.avatarEyeColor === next.avatarEyeColor && bot.avatarGlasses === next.avatarGlasses && bot.avatarMustache === next.avatarMustache;
        });
        return unchanged ? current : nextBots;
      });
    }
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [archivedExpanded, mode]);

  const persistPinnedTaskIds = useCallback((ids: ReadonlySet<string>): Promise<unknown> => {
    const request = pinnedWriteQueueRef.current
      .catch(() => undefined)
      .then(() => sendJson(PINNED_TASKS_API_PATH, { value: serializePinnedTaskIds(ids) }, "PUT"));
    pinnedWriteQueueRef.current = request.catch((error) => {
      setActionError(error instanceof Error && error.message ? error.message : "ピン留めの保存に失敗しました");
    });
    return request;
  }, []);

  const workingTaskIds = useMemo(
    () => paneTabIdsForWorkingTasks(
      tasksForSidebar(tasks.filter((task) => task.status === "working"), pinnedTaskIds),
      botSidebar.bots.filter((bot) => bot.codeInProgress === true).map((bot) => bot.id),
    ),
    [botSidebar.bots, pinnedTaskIds, tasks],
  );
  const hasWorking = workingTaskIds.length > 0;
  const workingCounts = useMemo<WorkingCounts>(() => {
    const workingBotTasks = tasks.filter((task) => task.status === "working" && task.kind === "bot");
    const primaryWorkingBotIds = new Set(
      workingBotTasks.flatMap((task) => task.botId && task.id === `bot:${task.botId}` ? [task.botId] : []),
    );
    const activeBotTabs = botSidebar.bots.filter((bot) =>
      (bot.codeInProgress === true || botStatusFor(`/bots/${encodeURIComponent(bot.id)}`) === "working")
      && !primaryWorkingBotIds.has(bot.id),
    ).length;
    return {
      bot: workingBotTasks.length + activeBotTabs,
      code: tasks.filter((task) => task.status === "working" && task.kind !== "bot").length,
    };
  }, [botSidebar.bots, botStatusFor, tasks]);
  useEffect(() => {
    let initialMode: AppMode = "code";
    try {
      const storedMode = localStorage.getItem(MODE_KEY);
      if (storedMode === "bot" || storedMode === "code") initialMode = storedMode;
      if (pathname.startsWith("/bots") && !paneMdUp) initialMode = "bot";
      setMode(initialMode);
      const storedWidth = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(storedWidth) && storedWidth >= MIN_WIDTH) setWidth(storedWidth);
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
      setExpanded(loadExpanded());
      setArchivedExpanded(localStorage.getItem(ARCHIVED_EXPANDED_KEY) === "1");
      setArchivedProjectsExpanded(localStorage.getItem(ARCHIVED_PROJECTS_EXPANDED_KEY) === "1");
    } catch {
      /* ignore */
    }
    void refresh(false, initialMode);
    const onChange = () => void refresh();
    window.addEventListener("webui:tasks-changed", onChange);
    return () => {
      window.removeEventListener("webui:tasks-changed", onChange);
    };
  }, [paneMdUp, refresh, pathname]);

  useEffect(() => {
    let cancelled = false;
    const legacyIds = loadLegacyPinnedTaskIds();
    if (legacyIds.size > 0) {
      pinnedTaskIdsRef.current = legacyIds;
      setPinnedTaskIds(legacyIds);
    }

    void getJson<{ value?: string | null }>(PINNED_TASKS_API_PATH)
      .then((data) => {
        if (cancelled) return;
        const raw = data?.value;
        const serverIds = raw === null || raw === undefined ? null : parsePinnedTaskIds(raw);
        // 設定ファイルが壊れている場合は、既存値を推測で上書きしない。
        if (typeof raw === "string" && serverIds === null) {
          pinnedLoadedRef.current = true;
          return;
        }

        const pendingToggles = pinnedPendingTogglesRef.current;
        const next = new Set(serverIds ?? legacyIds);
        for (const taskId of pendingToggles) {
          if (next.has(taskId)) next.delete(taskId);
          else next.add(taskId);
        }
        pinnedPendingTogglesRef.current = [];
        pinnedLoadedRef.current = true;
        pinnedTaskIdsRef.current = next;
        setPinnedTaskIds(next);

        if (typeof raw !== "string") {
          // Persist [] as well: auto-archive must wait until legacy pins are migrated.
          void persistPinnedTaskIds(next)
            .then(clearLegacyPinnedTaskIds)
            .catch(() => undefined);
        } else {
          clearLegacyPinnedTaskIds();
          if (pendingToggles.length > 0) {
            void persistPinnedTaskIds(next).catch(() => undefined);
          }
        }
      })
      .catch(() => {
        // サーバーに接続できない場合も、現在のUI状態は維持する。
        if (!cancelled) pinnedLoadedRef.current = true;
      });

    return () => {
      cancelled = true;
    };
  }, [persistPinnedTaskIds]);

  const changeMode = useCallback((next: AppMode) => {
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* ignore */ }
    // デスクトップは現在のペインを維持し、モバイルだけ従来どおりモードの入口へ遷移する。
    if (!paneMdUp) router.push(next === "bot" ? "/bots" : "/");
  }, [paneMdUp, router]);

  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const intervalMs = pageVisible && hasWorking ? POLL_WORKING_MS : POLL_IDLE_MS;
    const timer = setInterval(() => void refresh(!pageVisible), intervalMs);
    return () => clearInterval(timer);
  }, [refresh, hasWorking, pageVisible]);

  useEffect(() => {
    void refreshBotSidebar().catch(() => undefined);
    const timer = window.setInterval(() => {
      void refreshBotSidebar().catch(() => undefined);
    }, POLL_IDLE_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onDragEnd = (event: DragEvent) => {
      if (!taskDragActiveRef.current && !isTaskDrag(event.dataTransfer?.types ?? [])) return;
      taskDragActiveRef.current = false;
      void refresh();
    };
    document.addEventListener("dragend", onDragEnd);
    return () => document.removeEventListener("dragend", onDragEnd);
  }, [refresh]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(HOVER_QUERY);
    const update = () => setHoverCapable(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // 仕様 §2: タブ機構のある md 以上では provider の activeTaskId を
  // ハイライト・自動展開の源とする。モバイルは panes を触らないため pathname 由来のまま。
  const pathnameTaskId = pathname.startsWith("/task/") ? pathname.slice("/task/".length) : null;
  const activeTaskId = paneMdUp ? paneActiveTaskId : pathnameTaskId;
  const unreadActiveTaskId = pageVisible ? activeTaskId : null;
  const archivedProjectIds = new Set(archivedProjects.map((project) => project.id));
  const unreadCodeCount = tasks.filter((task) => task.status !== "archived" && task.kind !== "bot" && !archivedProjectIds.has(task.projectId ?? "") && hasUnreadTask(task, unreadActiveTaskId)).length;
  const unreadBotCount = botSidebar.bots.filter((bot) => unreadActiveTaskId !== `/bots/${encodeURIComponent(bot.id)}` && hasUnread(bot.lastMessageAt, getLastReadAt("bot", bot.id))).length
    + botSidebar.rooms.filter((room) => unreadActiveTaskId !== `/bots/rooms/${encodeURIComponent(room.id)}` && hasUnread(room.lastMessageAt, getLastReadAt("room", room.id))).length;
  const unreadModes: UnreadModes = {
    code: unreadCodeCount > 0,
    bot: unreadBotCount > 0,
  };
  const tabCount = unreadCodeCount + unreadBotCount + workingCounts.code + workingCounts.bot;
  useEffect(() => {
    const baseTitle = document.title.replace(/^\(\d+\) /, "");
    document.title = tabCount > 0 ? `(${tabCount}) ${baseTitle}` : baseTitle;
    return () => { document.title = baseTitle; };
  }, [tabCount, pathname]);

  const openTask = useCallback(
    (taskId: string) => {
      const href = `/task/${encodeURIComponent(taskId)}`;
      if (paneMdUp && splitHostEnabled) {
        // タブ切替は RSC を再取得せず、TaskPanesProvider の replaceState 経路を使う。
        retargetToUrl(taskId);
      } else if (paneMdUp) {
        // settings からの遷移だけは Host を有効化するため先に pathname を変える。
        window.history.pushState(null, "", href);
        retargetToUrl(taskId);
      } else {
        router.push(href);
      }
      onClose();
    },
    [onClose, paneMdUp, retargetToUrl, router, splitHostEnabled],
  );

  const openSettings = useCallback(() => {
    const href = "/settings";
    if (paneMdUp) {
      if (window.location.pathname !== href) window.history.pushState(null, "", href);
      retargetToUrl(SETTINGS_TAB_ID);
    } else {
      router.push(href);
    }
    onClose();
  }, [onClose, paneMdUp, retargetToUrl, router]);

  const openProjectHome = useCallback(
    (projectId: string) => {
      const href = `/?projectId=${encodeURIComponent(projectId)}`;
      if (paneMdUp) {
        // HomeView も pathname が変わらない場合があるため、query を先に反映する。
        window.history.pushState(null, "", href);
        retargetToUrl(HOME_TAB_ID);
      } else {
        router.push(href);
      }
      onClose();
    },
    [onClose, paneMdUp, retargetToUrl, router],
  );

  const openProject = useCallback(
    (projectId: string) => {
      const task = latestWorkingTask(tasks, projectId);
      if (task) {
        openTask(task.id);
        return;
      }
      openProjectHome(projectId);
    },
    [openProjectHome, openTask, tasks],
  );

  const openNoProject = useCallback(() => {
    const href = "/?noProject=1";
    if (paneMdUp) {
      window.history.pushState(null, "", href);
      retargetToUrl(HOME_TAB_ID);
    } else {
      router.push(href);
    }
    onClose();
  }, [onClose, paneMdUp, retargetToUrl, router]);

  const openHome = useCallback(() => {
    const href = "/";
    if (paneMdUp) {
      window.history.pushState(null, "", href);
      retargetToUrl(HOME_TAB_ID);
    } else {
      router.push(href);
    }
    onClose();
  }, [onClose, paneMdUp, retargetToUrl, router]);

  const resetPanesToTab = useCallback((tabId: string) => {
    // 進行中タスクがない場合は、既存の分割ペイン・タブをすべて閉じてから入口を表示する。
    dispatch({ type: "resetToTab", taskId: tabId });
    onClose();
  }, [dispatch, onClose]);

  const showWorkingTasks = useCallback(() => {
    if (!paneMdUp) return;
    if (workingTaskIds.length === 0) {
      resetPanesToTab(HOME_TAB_ID);
      return;
    }
    dispatch({ type: "showWorkingTasks", taskIds: workingTaskIds });
    onClose();
  }, [dispatch, onClose, paneMdUp, resetPanesToTab, workingTaskIds]);

  const tasksByProject = useMemo(() => {
    const map = new Map<string | null, TaskSummary[]>();
    for (const task of tasks) {
      if (!isCodeTask(task)) continue;
      const list = map.get(task.projectId) ?? [];
      list.push(task);
      map.set(task.projectId, list);
    }
    const compareTasks = sidebarTaskComparator(pinnedTaskIds);
    for (const list of map.values()) {
      sortTasksForSidebarInPlace(list, pinnedTaskIds, compareTasks);
    }
    return map;
  }, [pinnedTaskIds, tasks]);
  const noProjectTasks = tasksByProject.get(null) ?? [];
  const activeTask = activeTaskId === null ? undefined : tasks.find((task) => task.id === activeTaskId);
  const activeGroupId = activeTask
    ? activeTask.projectId ?? NO_PROJECT_GROUP_ID
    : null;
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  // アクティブタスクへ移動した時だけ自動展開し、同じグループの手動折りたたみを尊重する。
  useEffect(() => {
    if (activeGroupId === null) return;
    setExpanded((current) => {
      if (current.has(activeGroupId)) return current;
      const next = new Set(current);
      next.add(activeGroupId);
      saveExpanded(next);
      return next;
    });
  }, [activeGroupId]);

  const noProjectOpen = expanded.has(NO_PROJECT_GROUP_ID);

  const { archivedGroups, archivedTaskCount } = useMemo(() => {
    const groups = new Map<string, { name: string; tasks: TaskSummary[] }>();
    let taskCount = 0;
    for (const task of archivedTasks) {
      if (!isCodeTask(task)) continue;
      taskCount += 1;
      const key = task.projectId ? `project:${task.projectId}` : "no-project";
      const group = groups.get(key) ?? { name: task.projectName, tasks: [] };
      group.tasks.push(task);
      groups.set(key, group);
    }
    return {
      archivedTaskCount: taskCount,
      archivedGroups: [...groups.entries()].map(([key, group]) => ({
        key,
        name: group.name,
        tasks: group.tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      })),
    };
  }, [archivedTasks]);

  const orderedProjects = useMemo(() => {
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const seen = new Set<string>();
    const ordered: ProjectDto[] = [];
    for (const id of projectOrder) {
      const project = projectsById.get(id);
      if (!project || seen.has(id)) continue;
      seen.add(id);
      ordered.push(project);
    }
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      seen.add(project.id);
      ordered.push(project);
    }
    return ordered;
  }, [projects, projectOrder]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchesCodeSearch = (value: string) =>
    !normalizedQuery || value.toLocaleLowerCase().includes(normalizedQuery);
  const filteredTasks = (groupName: string, groupTasks: TaskSummary[]) =>
    matchesCodeSearch(groupName)
      ? groupTasks
      : groupTasks.filter((task) => matchesCodeSearch(task.title));
  const visibleNoProjectTasks = filteredTasks(NO_PROJECT_NAME, noProjectTasks);
  const matchingTasksByProject = normalizedQuery ? new Map<string, TaskSummary[]>() : null;
  const visibleProjects = orderedProjects.filter((project) => {
    if (matchesCodeSearch(project.name)) return true;

    let matches: TaskSummary[] | null = null;
    for (const task of tasksByProject.get(project.id) ?? []) {
      if (!matchesCodeSearch(task.title)) continue;
      (matches ??= []).push(task);
    }
    if (!matches) return false;
    matchingTasksByProject?.set(project.id, matches);
    return true;
  });
  const visibleArchivedGroups: typeof archivedGroups = [];
  for (const group of archivedGroups) {
    if (matchesCodeSearch(group.name)) {
      visibleArchivedGroups.push(group);
      continue;
    }
    const matchingTasks = group.tasks.filter((task) => matchesCodeSearch(task.title));
    if (matchingTasks.length > 0) visibleArchivedGroups.push({ ...group, tasks: matchingTasks });
  }
  const visibleArchivedProjects = archivedProjects.filter((project) => matchesCodeSearch(project.name));
  const showNoProject =
    !normalizedQuery || matchesCodeSearch(NO_PROJECT_NAME) || visibleNoProjectTasks.length > 0;
  const visibleNoProjectRunning = showNoProject ? countRunningTasks(visibleNoProjectTasks) : 0;

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveExpanded(next);
      return next;
    });
  }

  const togglePinned = useCallback((taskId: string) => {
    const next = new Set(pinnedTaskIdsRef.current);
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    pinnedTaskIdsRef.current = next;
    if (!pinnedLoadedRef.current) pinnedPendingTogglesRef.current.push(taskId);
    setPinnedTaskIds(next);
    if (pinnedLoadedRef.current) void persistPinnedTaskIds(next).catch(() => undefined);
  }, [persistPinnedTaskIds]);

  const reorderProjects = useCallback(
    (sourceId: string, targetId: string, placement: ProjectDropPlacement = "before"): boolean => {
      const nextOrder = reorderProjectIds(
        orderedProjects.map((project) => project.id),
        sourceId,
        targetId,
        placement,
      );
      if (!nextOrder) return false;
      setProjectOrder(nextOrder);
      saveProjectOrder(nextOrder);
      return true;
    },
    [orderedProjects],
  );

  const handleProjectDragStart = useCallback(
    (event: React.DragEvent<HTMLElement>, projectId: string) => {
      if (orderedProjects.length < 2) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(PROJECT_DRAG_MIME, projectId);
      event.dataTransfer.setData("text/plain", projectId);
      setDraggedProjectId(projectId);
      setDragOverProjectId(null);
      setKeyboardDraggedProjectId(null);
    },
    [orderedProjects.length],
  );

  const handleProjectDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>, projectId: string) => {
      const sourceId = draggedProjectId || projectDragIdFromDataTransfer(event.dataTransfer);
      if (!sourceId || sourceId === projectId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDragOverProjectId(projectId);
    },
    [draggedProjectId],
  );

  const handleProjectDrop = useCallback(
    (event: React.DragEvent<HTMLElement>, targetId: string) => {
      const sourceId = projectDragIdFromDataTransfer(event.dataTransfer) || draggedProjectId;
      // Do not consume task/external drops that bubble through the project row.
      if (!sourceId) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const placement: ProjectDropPlacement =
        event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
      if (reorderProjects(sourceId, targetId, placement)) {
        const source = orderedProjects.find((project) => project.id === sourceId);
        const target = orderedProjects.find((project) => project.id === targetId);
        if (source && target) {
          setReorderAnnouncement(
            `${source.name}を${target.name}の${placement === "after" ? "後ろ" : "前"}に移動しました`,
          );
        }
      }
      setDraggedProjectId(null);
      setDragOverProjectId(null);
    },
    [draggedProjectId, orderedProjects, reorderProjects],
  );

  const handleProjectDragEnd = useCallback(() => {
    setDraggedProjectId(null);
    setDragOverProjectId(null);
  }, []);

  const handleProjectKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, projectId: string) => {
      if (orderedProjects.length < 2) return;
      const project = orderedProjects.find((item) => item.id === projectId);
      if (!project) return;

      if (event.key === " " && keyboardDraggedProjectId === null) {
        event.preventDefault();
        setKeyboardDraggedProjectId(projectId);
        setReorderAnnouncement(
          `${project.name}の並べ替えを開始しました。上下矢印で移動し、スペースで終了します`,
        );
        return;
      }

      if (keyboardDraggedProjectId !== projectId) return;
      if (event.key === "Escape" || event.key === " ") {
        event.preventDefault();
        setKeyboardDraggedProjectId(null);
        setReorderAnnouncement(`${project.name}の並べ替えを終了しました`);
        return;
      }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;

      event.preventDefault();
      const currentIndex = orderedProjects.findIndex((item) => item.id === projectId);
      const targetIndex = currentIndex + (event.key === "ArrowUp" ? -1 : 1);
      const target = orderedProjects[targetIndex];
      if (!target) {
        setReorderAnnouncement(
          `${project.name}はこれ以上${event.key === "ArrowUp" ? "上" : "下"}へ移動できません`,
        );
        return;
      }
      const moveAfter = event.key === "ArrowDown";
      reorderProjects(projectId, target.id, moveAfter ? "after" : "before");
      setReorderAnnouncement(
        `${project.name}を${target.name}の${event.key === "ArrowUp" ? "前" : "後ろ"}へ移動しました`,
      );
    },
    [keyboardDraggedProjectId, orderedProjects, reorderProjects],
  );

  const runAction = useCallback(async (
    key: string,
    action: () => Promise<unknown>,
    options?: { refresh?: boolean; notify?: boolean },
  ) => {
    if (actionBusyKey) return undefined;
    setActionError(null);
    setActionBusyKey(key);
    try {
      return await action();
    } catch (err) {
      console.error("[sidebar] action failed", err);
      setActionError(err instanceof Error ? err.message : "サイドバーの操作に失敗しました");
      return undefined;
    } finally {
      setActionBusyKey(null);
      if (options?.refresh !== false) void refresh();
      if (options?.notify !== false) notifyTasksChanged();
    }
  }, [actionBusyKey, refresh]);

  const archiveTask = useCallback((taskId: string) => {
    void runAction(`archive:${taskId}`, () =>
      sendJson(`/api/tasks/${encodeURIComponent(taskId)}`, undefined, "DELETE"),
    );
  }, [runAction]);

  const handleTaskDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>, taskId: string) => {
    taskDragActiveRef.current = true;
    event.dataTransfer.effectAllowed = "move";
    setTaskDragData(event.dataTransfer, taskId);
  }, []);

  async function restoreArchivedTask(task: TaskSummary) {
    await runAction(`restore:${task.id}`, () =>
      sendJson(`/api/tasks/${encodeURIComponent(task.id)}`, { archived: false }, "PATCH"),
    );
  }

  async function destroyArchivedTask(task: TaskSummary) {
    await runAction(`destroy:${task.id}`, () =>
      sendJson(`/api/tasks/${encodeURIComponent(task.id)}?hard=1`, undefined, "DELETE"),
    );
  }

  async function destroyArchivedGroup(group: { key: string; name: string; tasks: TaskSummary[] }) {
    if (!window.confirm(`「${group.name}」のアーカイブ済みタスクを${group.tasks.length}件すべて完全に削除しますか？`)) return;
    const projectId = group.tasks[0]?.projectId;
    if (projectId === undefined) return;
    const query = projectId === null
      ? "noProject=1"
      : `projectId=${encodeURIComponent(projectId)}`;
    await runAction(`destroy-group:${group.key}`, () =>
      sendJson(`/api/tasks?${query}`, undefined, "DELETE"),
    );
  }

  async function archiveProjectAction(project: ProjectDto) {
    await runAction(`archive-project:${project.id}`, () =>
      sendJson("/api/projects", { id: project.id, archived: true }, "PATCH"),
    );
  }

  async function restoreProjectAction(project: ProjectDto) {
    await runAction(`restore-project:${project.id}`, () =>
      sendJson("/api/projects", { id: project.id, archived: false }, "PATCH"),
    );
  }

  async function destroyProjectAction(project: ProjectDto) {
    if (!window.confirm(`プロジェクト「${project.name}」と関連タスクを完全に削除しますか？`)) return;
    await runAction(`destroy-project:${project.id}`, () =>
      sendJson(`/api/projects?id=${encodeURIComponent(project.id)}`, undefined, "DELETE"),
    );
  }

  const replaceProject = useCallback((updated: ProjectDto) => {
    setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
    setArchivedProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
    setProjectSettingsProject((current) => current?.id === updated.id ? updated : current);
  }, []);

  async function patchProjectFromSidebar(project: ProjectDto, key: string, patch: Record<string, unknown>) {
    const result = await runAction(
      key,
      () => sendJson<{ project: ProjectDto }>("/api/projects", { id: project.id, ...patch }, "PATCH"),
      { refresh: false, notify: false },
    ) as { project?: ProjectDto } | undefined;
    if (!result?.project) return;

    // Ignore an older project poll that was already in flight when this update completed.
    refreshGenRef.current += 1;
    replaceProject(result.project);
    notifyTasksChanged(project.id);
  }

  async function clearProjectIcon(project: ProjectDto) {
    await patchProjectFromSidebar(project, `icon:${project.id}`, { icon: null });
  }

  async function setProjectIconColor(project: ProjectDto, iconColor: ProjectDto["iconColor"]) {
    await patchProjectFromSidebar(project, `icon-color:${project.id}`, { iconColor });
  }

  async function markProjectTasksRead(projectId: string) {
    const { tasks: allTasks } = await getJson<{ tasks: TaskSummary[] }>("/api/tasks?archived=1&kind=all");
    for (const task of allTasks) {
      if (task.projectId === projectId && task.status !== "working") {
        markRead("task", task.id, Date.parse(task.updatedAt));
      }
    }
  }

  async function migrateProjectAction(project: ProjectDto, destinationPath: string) {
    if (actionBusyKey) throw new Error("別の操作が完了するまでお待ちください");
    setActionError(null);
    setActionBusyKey(`migrate-project:${project.id}`);
    try {
      const result = await sendJson<{ warning?: string }>(
        "/api/projects",
        { id: project.id, destinationPath },
        "PATCH",
      );
      if (result.warning) window.alert(result.warning);
    } catch (err) {
      const message = err instanceof Error ? err.message : "プロジェクトの移動に失敗しました";
      setActionError(message);
      throw err;
    } finally {
      setActionBusyKey(null);
      void refresh();
      notifyTasksChanged();
    }
  }

  async function setProjectIcon(project: ProjectDto, file: File | null) {
    if (!file) return;
    if (!file.type.match(/^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)$/)) {
      window.alert("PNG・JPEG・GIF・WebP・ICO の画像を選択してください。");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      window.alert("2 MB以下の画像を選択してください。");
      return;
    }
    setActionError(null);
    const showReaderError = () => {
      setActionError("プロジェクトアイコンの読み込みに失敗しました");
    };
    const reader = new FileReader();
    reader.onload = () => {
      void patchProjectFromSidebar(project, `icon:${project.id}`, { icon: String(reader.result) });
    };
    reader.onerror = showReaderError;
    try {
      reader.readAsDataURL(file);
    } catch {
      showReaderError();
    }
  }

  /** ホストPCのネイティブダイアログで選ばれた画像を保存する。 */
  async function setProjectIconData(project: ProjectDto, icon: string) {
    await patchProjectFromSidebar(project, `icon:${project.id}`, { icon });
  }

  const cancelProjectTaskMenuHide = useCallback(() => {
    if (projectTaskMenuHideTimerRef.current === null) return;
    clearTimeout(projectTaskMenuHideTimerRef.current);
    projectTaskMenuHideTimerRef.current = null;
  }, []);

  const scheduleProjectTaskMenuHide = useCallback(() => {
    if (!hoverCapable) return;
    cancelProjectTaskMenuHide();
    projectTaskMenuHideTimerRef.current = setTimeout(() => {
      setProjectTaskMenu(null);
      projectTaskMenuHideTimerRef.current = null;
    }, 180);
  }, [cancelProjectTaskMenuHide, hoverCapable]);

  const showProjectTaskMenu = useCallback(
    (projectId: string, target: HTMLElement) => {
      cancelProjectTaskMenuHide();
      const rect = target.getBoundingClientRect();
      const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
      const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
      const menuWidth = Math.min(288, Math.max(160, viewportWidth - 16));
      const menuHeight = Math.min(360, Math.max(120, viewportHeight - 16));
      setProjectTaskMenu({
        projectId,
        top: Math.max(8, Math.min(rect.top, viewportHeight - menuHeight - 8)),
        left: Math.max(8, Math.min(rect.right + 8, viewportWidth - menuWidth - 8)),
      });
    },
    [cancelProjectTaskMenuHide],
  );

  useEffect(() => {
    if (collapsed && mdUp) return;
    cancelProjectTaskMenuHide();
    setProjectTaskMenu(null);
  }, [cancelProjectTaskMenuHide, collapsed, mdUp]);

  const cancelRailWidgetHide = useCallback(() => {
    if (railWidgetHideTimerRef.current === null) return;
    clearTimeout(railWidgetHideTimerRef.current);
    railWidgetHideTimerRef.current = null;
  }, []);

  const scheduleRailWidgetHide = useCallback(() => {
    if (!hoverCapable) return;
    cancelRailWidgetHide();
    railWidgetHideTimerRef.current = setTimeout(() => {
      setRailWidget(null);
      railWidgetHideTimerRef.current = null;
    }, 180);
  }, [cancelRailWidgetHide, hoverCapable]);

  const showRailWidget = useCallback(
    (widget: RailWidget, target: HTMLElement) => {
      cancelRailWidgetHide();
      const rect = target.getBoundingClientRect();
      const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
      const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
      const popupWidth = Math.min(576, viewportWidth - 96);
      // フッターアイコンの右・上方向に開く。bottom アンカーなので max-height 分伸しても下にはみ出さない。
      setRailWidgetPos({
        bottom: Math.max(8, viewportHeight - rect.bottom),
        left: Math.max(8, Math.min(rect.right + 8, viewportWidth - popupWidth - 8)),
      });
      setRailWidget(widget);
    },
    [cancelRailWidgetHide],
  );

  useEffect(() => {
    if (!railWidget) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (railWidgetRef.current?.contains(target)) return;
      if (target.closest("[data-rail-widget-button]")) return;
      setRailWidget(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRailWidget(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [railWidget]);

  useEffect(() => {
    if (!projectTaskMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (projectTaskMenuRef.current?.contains(target)) return;
      if (target.closest("[data-project-id]")) return;
      setProjectTaskMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectTaskMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [projectTaskMenu]);

  useEffect(
    () => () => {
      cancelProjectTaskMenuHide();
      cancelRailWidgetHide();
    },
    [cancelProjectTaskMenuHide, cancelRailWidgetHide],
  );

  const renderTaskList = (children: TaskSummary[]) => (
    <ul
      className={cx(
        "mb-1 ml-5 space-y-0.5 border-l border-border pl-1.5",
        children.length >= 5 && "max-h-72 overflow-y-auto",
      )}
    >
      {children.length === 0 ? (
        <li className="px-2 py-1.5 text-[11px] text-muted">タスクなし</li>
      ) : children.map((task) => (
        <SidebarTaskRow
          key={task.id}
          task={task}
          active={task.id === activeTaskId}
          bot={(task.botId ?? task.supervisorBotId) ? botsById.get(task.botId ?? task.supervisorBotId!) : undefined}
          pinned={pinnedTaskIds.has(task.id)}
          unread={hasUnreadTask(task, activeTaskId)}
          mdUp={mdUp}
          actionBusy={actionBusyKey !== null}
          onOpenTask={openTask}
          onPinTask={togglePinned}
          onPromoteTask={setPromotionTask}
          onArchiveTask={archiveTask}
          onDragStart={handleTaskDragStart}
        />
      ))}
    </ul>
  );

  // `collapsed` はデスクトップ専用のレール表示（collapsedRail）用。body は
  // デスクトップでは !collapsed のときだけ描画され、モバイルドロワーは常に全幅なので、
  // body 内で collapsed を参照してはいけない（参照すると 240px 幅のまま
  // プロジェクト名もタスクもフッターも消えたドロワーになる）。
  const sidebarError = actionError ?? refreshError;
  const body = (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          aria-label={mdUp ? "サイドバーを折りたたむ" : "メニューを閉じる"}
          onClick={() => {
            if (!mdUp) {
              onClose();
              return;
            }
            setCollapsed(true);
            localStorage.setItem(COLLAPSED_KEY, "1");
          }}
          className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-surface-2 md:h-8 md:w-8"
        >
          {mdUp ? <Menu className="h-5 w-5 text-muted" /> : <X className="h-5 w-5 text-muted" />}
        </button>
        <Link href="/" onClick={onClose} className="flex min-w-0 items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="h-6 w-6 rounded-[5px]" />
          <span className="truncate text-sm font-semibold">LeafCodePi</span>
        </Link>
        <button
          type="button"
          aria-label="新規タスクを作成"
          title="新規タスク"
          onClick={openHome}
          className="ml-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
        >
          <Plus className="h-4 w-4" />
        </button>
        <AddProjectButton
          variant="icon"
          onAdded={() => void refresh()}
          className="h-11 w-11 shrink-0"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <ModeSegment mode={mode} onChange={changeMode} workingCounts={workingCounts} unreadModes={unreadModes} />
        <label className="mb-2 flex h-9 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-xs text-muted focus-within:border-accent">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="プロジェクトやセッションを検索"
            aria-label="プロジェクトやセッションを検索"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
          />
        </label>
        {sidebarError && !projectSettingsProject && (
          <p role="alert" className="mb-2 rounded-lg border border-danger/30 bg-danger-bg px-2.5 py-2 text-xs text-danger">
            {sidebarError}
          </p>
        )}
        <span className="sr-only">
          ドラッグしてプロジェクトを並べ替えます。キーボードではスペースで開始し、上下矢印で移動、スペースで終了します。
        </span>
        <span role="status" aria-live="polite" className="sr-only">
          {reorderAnnouncement}
        </span>
        <ul className="space-y-1">
          {showNoProject && (
            <li>
              <div className="flex items-center gap-0.5 rounded-lg">
                <button
                  type="button"
                  aria-expanded={noProjectOpen}
                  aria-label={`${NO_PROJECT_NAME}${noProjectOpen ? "を折りたたむ" : "を展開"}`}
                  onClick={() => toggleExpanded(NO_PROJECT_GROUP_ID)}
                  className="inline-flex h-8 w-6 items-center justify-center text-faint"
                >
                  <ChevronRight className={cx("h-3.5 w-3.5 transition", noProjectOpen && "rotate-90")} />
                </button>
                <button
                  type="button"
                  onClick={openNoProject}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-muted">
                    <Folder className="h-3 w-3" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{NO_PROJECT_NAME}</span>
                  {noProjectTasks.some((task) => hasUnreadTask(task, activeTaskId)) && <span aria-label="未読" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                  {visibleNoProjectRunning > 0 && (
                    <span className="inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-working px-1 text-[10px] font-semibold text-primary-fg">
                      {visibleNoProjectRunning}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`${NO_PROJECT_NAME}で新規タスクを作成`}
                  title="プロジェクトなしで新規タスク"
                  onClick={openNoProject}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted hover:text-text md:h-8 md:w-8"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              {noProjectOpen && renderTaskList(visibleNoProjectTasks)}
            </li>
          )}
          {visibleProjects.map((project) => {
              const allChildren = tasksByProject.get(project.id) ?? [];
              const children = matchingTasksByProject?.get(project.id) ?? allChildren;
              const open = expanded.has(project.id);
              const running = countRunningTasks(children);
              const unread = allChildren.some((task) => hasUnreadTask(task, activeTaskId));
              return (
                <li key={project.id}>
                  <SwipeArchiveRow
                    label={`${project.name}をアーカイブ`}
                    disabled={actionBusyKey !== null}
                    onArchive={() => void archiveProjectAction(project)}
                  >
                  <div
                    data-project-row={project.id}
                    className={cx(
                      "flex items-center gap-0.5 rounded-lg",
                      draggedProjectId === project.id && "opacity-50",
                      dragOverProjectId === project.id && draggedProjectId !== project.id && "bg-surface-3",
                    )}
                    onDragOver={(event) => handleProjectDragOver(event, project.id)}
                    onDragLeave={(event) => {
                      const relatedTarget = event.relatedTarget;
                      if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
                        setDragOverProjectId((current) => (current === project.id ? null : current));
                      }
                    }}
                    onDrop={(event) => handleProjectDrop(event, project.id)}
                  >
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={`${project.name}を${open ? "折りたたむ" : "展開"}`}
                      aria-grabbed={draggedProjectId === project.id || keyboardDraggedProjectId === project.id}
                      draggable={orderedProjects.length > 1}
                      onDragStart={(event) => handleProjectDragStart(event, project.id)}
                      onDragEnd={handleProjectDragEnd}
                      onKeyDown={(event) => handleProjectKeyDown(event, project.id)}
                      onClick={() => toggleExpanded(project.id)}
                      className={cx(
                        "inline-flex h-8 w-6 items-center justify-center text-faint",
                        orderedProjects.length > 1 && "cursor-grab active:cursor-grabbing",
                      )}
                    >
                      <ChevronRight className={cx("h-3.5 w-3.5 transition", open && "rotate-90")} />
                    </button>
                    <ProjectIcon
                      project={project}
                      className={cx(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px] font-medium",
                        !project.icon && "border",
                      )}
                    />
                    <button
                      type="button"
                      draggable={orderedProjects.length > 1}
                      onDragStart={(event) => handleProjectDragStart(event, project.id)}
                      onDragEnd={handleProjectDragEnd}
                      onClick={() => openProject(project.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>
                      {unread && <span aria-label="未読" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                      {running > 0 && (
                        <span className="inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-working px-1 text-[10px] font-semibold text-primary-fg">
                          {running}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={`${project.name}に新規タスクを作成`}
                      title="新規タスク"
                      onClick={() => openProjectHome(project.id)}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted hover:text-text md:h-8 md:w-8"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`${project.name}の設定`}
                      title="プロジェクト設定"
                      disabled={actionBusyKey !== null}
                      onClick={() => setProjectSettingsProject(project)}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40 md:h-8 md:w-8"
                    >
                      <Settings className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  </SwipeArchiveRow>
                  {open && renderTaskList(children)}
                </li>
              );
            })}
        </ul>

        <div className="mt-2">
          <button
            type="button"
            aria-expanded={archivedExpanded}
            aria-label={`アーカイブ${archivedExpanded ? "を折りたたむ" : "を展開"}`}
            onClick={() => {
              const next = !archivedExpanded;
              setArchivedExpanded(next);
              try {
                localStorage.setItem(ARCHIVED_EXPANDED_KEY, next ? "1" : "0");
              } catch {
                /* ignore */
              }
            }}
            className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-muted hover:bg-surface-2 hover:text-text"
          >
            <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">アーカイブ</span>
            <span className="tabular-nums text-[10px] text-muted">{archivedTaskCount}</span>
            <ChevronRight
              className={cx("h-3 w-3 shrink-0 transition-transform", archivedExpanded && "rotate-90")}
              aria-hidden="true"
            />
          </button>
          {archivedExpanded && (
            <ul className="mb-1 ml-2 space-y-0.5 border-l border-border pl-1.5">
              {visibleArchivedGroups.length === 0 ? (
                <li className="px-2 py-1.5 text-[11px] text-muted">
                  アーカイブされたタスクはありません
                </li>
              ) : (
                visibleArchivedGroups.map((group) => (
                  <li key={group.key}>
                    <div className="flex items-center gap-0.5">
                      <span className="min-w-0 flex-1 truncate px-1.5 py-1 text-[11px] font-medium text-muted">
                        {group.name}
                        <span className="ml-1 tabular-nums text-[10px] text-faint">
                          {group.tasks.length}
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={`${group.name}のアーカイブを一括削除`}
                        title="このプロジェクトのアーカイブを一括削除"
                        disabled={actionBusyKey !== null}
                        onClick={() => void destroyArchivedGroup(group)}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-faint hover:bg-danger-bg hover:text-danger disabled:opacity-50 md:h-6 md:w-6"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <ul className="ml-2 space-y-0.5 border-l border-border pl-1.5">
                      {group.tasks.map((task) => (
                        <li key={task.id}>
                          <div className="flex items-center gap-0.5 rounded-lg text-muted hover:bg-surface-2 hover:text-text">
                            <button
                              type="button"
                              onClick={() => openTask(task.id)}
                              className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
                            >
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-faint" />
                              <span className="relative top-0.5 flex min-w-0 flex-1 flex-col items-start">
                                <span className="w-full truncate text-xs font-medium">{task.title}</span>
                                <span className="flex w-full min-w-0 items-center gap-1">
                                  <span className="flex w-11 shrink-0 items-center">
                                    <SessionLabelBadge labelId={task.label} className="w-full truncate text-center" />
                                  </span>
                                  <span className="w-16 shrink-0 truncate text-[10px] text-muted">{timeAgo(task.updatedAt)}</span>
                                </span>
                              </span>
                            </button>
                            <button
                              type="button"
                              aria-label={`「${task.title}」を復元`}
                              title="タスクを復元"
                              disabled={actionBusyKey !== null}
                              onClick={() => void restoreArchivedTask(task)}
                              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface-2 hover:text-text disabled:opacity-50 md:h-6 md:w-6"
                            >
                              <ArchiveRestore className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              aria-label={`「${task.title}」を完全に削除`}
                              title="タスクを完全に削除"
                              disabled={actionBusyKey !== null}
                              onClick={() => void destroyArchivedTask(task)}
                              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-faint hover:bg-danger-bg hover:text-danger disabled:opacity-50 md:h-6 md:w-6"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))
              )}
            </ul>
          )}
          {visibleArchivedProjects.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                aria-expanded={archivedProjectsExpanded}
                aria-label={`アーカイブ済みプロジェクト${archivedProjectsExpanded ? "を折りたたむ" : "を展開"}`}
                onClick={() => {
                  const next = !archivedProjectsExpanded;
                  setArchivedProjectsExpanded(next);
                  try {
                    localStorage.setItem(ARCHIVED_PROJECTS_EXPANDED_KEY, next ? "1" : "0");
                  } catch {
                    /* ignore */
                  }
                }}
                className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-muted hover:bg-surface-2 hover:text-text"
              >
                <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">アーカイブ済みプロジェクト</span>
                <span className="tabular-nums text-[10px] text-muted">{visibleArchivedProjects.length}</span>
                <ChevronRight
                  className={cx("h-3 w-3 shrink-0 transition-transform", archivedProjectsExpanded && "rotate-90")}
                  aria-hidden="true"
                />
              </button>
              {archivedProjectsExpanded && (
              <ul className="ml-2 space-y-0.5 border-l border-border pl-1.5">
                {visibleArchivedProjects.map((project) => (
                  <li key={project.id}>
                    <div className="flex items-center gap-0.5 rounded-lg text-muted hover:bg-surface-2 hover:text-text">
                      <button
                        type="button"
                        onClick={() => openProject(project.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{project.name}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`${project.name}を復元`}
                        title="プロジェクトを復元"
                        disabled={actionBusyKey !== null}
                        onClick={() => void restoreProjectAction(project)}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface-2 hover:text-text disabled:opacity-50 md:h-6 md:w-6"
                      >
                        <ArchiveRestore className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`${project.name}を完全に削除`}
                        title="プロジェクトを完全に削除"
                        disabled={actionBusyKey !== null}
                        onClick={() => void destroyProjectAction(project)}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-faint hover:bg-danger-bg hover:text-danger disabled:opacity-50 md:h-6 md:w-6"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <SidebarFooter health={health} onSettings={openSettings} />
    </div>
  );

  const currentProjectSettingsProject = projectSettingsProject
    ? projects.find((project) => project.id === projectSettingsProject.id) ?? projectSettingsProject
    : null;
  const projectTaskMenuProject = projectTaskMenu
    ? orderedProjects.find((project) => project.id === projectTaskMenu.projectId)
    : undefined;
  const projectTaskMenuTasks = projectTaskMenuProject
    ? (tasksByProject.get(projectTaskMenuProject.id) ?? []).slice(0, 20)
    : [];

  const collapseBotSidebar = useCallback(() => {
    setCollapsed(true);
    localStorage.setItem(COLLAPSED_KEY, "1");
  }, []);
  const expandBotSidebar = useCallback(() => {
    setCollapsed(false);
    localStorage.setItem(COLLAPSED_KEY, "0");
  }, []);
  const botBody = (
    <BotSidebarBody
      onClose={onClose}
      onChangeMode={changeMode}
      onSettings={openSettings}
      workingCounts={workingCounts}
      unreadModes={unreadModes}
      health={health}
      mdUp={mdUp}
      collapsed={collapsed && mdUp}
      onCollapse={collapseBotSidebar}
      onExpand={expandBotSidebar}
      onShowWorkingTasks={showWorkingTasks}
      hasWorking={hasWorking}
    />
  );

  const noProjectActive = activeTask?.projectId === null;
  const collapsedRail = (
    <div className="flex h-full w-full flex-col items-center bg-surface">
      <div className="flex h-14 w-full items-center justify-center border-b border-border">
        <button
          type="button"
          aria-label="サイドバーを展開"
          onClick={() => {
            setCollapsed(false);
            localStorage.setItem(COLLAPSED_KEY, "0");
          }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-surface-2"
        >
          <Menu className="h-5 w-5 text-muted" />
        </button>
      </div>
      {sidebarError && !projectSettingsProject && (
        <p role="alert" className="w-full break-words px-1 py-2 text-center text-[10px] text-danger">
          {sidebarError}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ul className="flex flex-col items-center gap-3">
          <li>
            <button
              type="button"
              title={NO_PROJECT_NAME}
              aria-label={`${NO_PROJECT_NAME}を選択`}
              aria-current={noProjectActive ? "page" : undefined}
              onClick={openNoProject}
              className={cx(
                "group relative inline-flex h-12 w-12 items-center justify-center rounded-xl p-1 hover:bg-surface-2",
                noProjectActive && "bg-surface-2 ring-1 ring-inset ring-accent/20",
              )}
            >
              <span className="flex h-full w-full items-center justify-center rounded-lg border border-border bg-surface-2 text-muted transition-transform group-hover:scale-105">
                <Folder className="h-5 w-5" />
              </span>
              {noProjectTasks.some((task) => hasUnreadTask(task, activeTaskId)) && <span aria-label="未読" className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent" />}
              {countRunningTasks(noProjectTasks) > 0 && (
                <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full border-2 border-surface bg-working px-1 text-[10px] font-semibold text-primary-fg">
                  {countRunningTasks(noProjectTasks)}
                </span>
              )}
            </button>
          </li>
          {orderedProjects.map((project) => {
            const projectTasks = tasksByProject.get(project.id) ?? [];
            const running = countRunningTasks(projectTasks);
            const unread = projectTasks.some((task) => hasUnreadTask(task, activeTaskId));
            const active = activeTask?.projectId === project.id;
            const tapOpensMenu = !hoverCapable;
            const menuOpen = projectTaskMenu?.projectId === project.id;
            const projectLabel = tapOpensMenu
              ? running > 0
                ? `${project.name}のタスクを表示（実行中のタスク${running}件）`
                : `${project.name}のタスクを表示`
              : running > 0
                ? `${project.name}を選択（実行中のタスク${running}件）`
                : `${project.name}を選択`;
            return (
              <li key={project.id}>
                <button
                  type="button"
                  title={projectLabel}
                  aria-label={projectLabel}
                  aria-current={active ? "page" : undefined}
                  aria-haspopup={tapOpensMenu ? "menu" : undefined}
                  aria-expanded={tapOpensMenu ? menuOpen : undefined}
                  data-project-id={project.id}
                  onClick={(event) => {
                    if (!tapOpensMenu) {
                      openProject(project.id);
                      return;
                    }
                    if (menuOpen) {
                      setProjectTaskMenu(null);
                      return;
                    }
                    showProjectTaskMenu(project.id, event.currentTarget);
                  }}
                  onMouseEnter={(event) => showProjectTaskMenu(project.id, event.currentTarget)}
                  onMouseLeave={scheduleProjectTaskMenuHide}
                  onFocus={(event) => {
                    if (hoverCapable) showProjectTaskMenu(project.id, event.currentTarget);
                  }}
                  onBlur={scheduleProjectTaskMenuHide}
                  className={cx(
                    "group relative inline-flex h-12 w-12 items-center justify-center rounded-xl p-1 hover:bg-surface-2",
                    active && "bg-surface-2 ring-1 ring-inset ring-accent/20",
                  )}
                >
                  <ProjectIcon
                    project={project}
                    className={cx(
                      "flex h-full w-full items-center justify-center rounded-lg text-base font-medium transition-transform group-hover:scale-105",
                      !project.icon && "border",
                    )}
                  />
                  {unread && <span aria-label="未読" className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent" />}
                  {running > 0 && (
                    <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full border-2 border-surface bg-working px-1 text-[10px] font-semibold text-primary-fg">
                      {running}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="flex w-full flex-col items-center gap-1 border-t border-border py-2">
        <WorkingTasksButton
          hasWorking={hasWorking}
          mdUp={paneMdUp}
          onClick={showWorkingTasks}
        />
        <AddProjectButton variant="icon" icon="plus" className="h-11 w-11" onAdded={() => void refresh()} />
        <button
          type="button"
          aria-label="CodexBar 利用状況を表示"
          title="CodexBar 利用状況"
          aria-haspopup="dialog"
          aria-expanded={railWidget === "codexbar"}
          data-rail-widget-button="codexbar"
          onClick={(event) => {
            if (railWidget === "codexbar") {
              setRailWidget(null);
              return;
            }
            showRailWidget("codexbar", event.currentTarget);
          }}
          onMouseEnter={(event) => showRailWidget("codexbar", event.currentTarget)}
          onMouseLeave={scheduleRailWidgetHide}
          onFocus={(event) => {
            if (hoverCapable) showRailWidget("codexbar", event.currentTarget);
          }}
          onBlur={scheduleRailWidgetHide}
          className={cx(
            "inline-flex h-11 w-11 items-center justify-center rounded-xl hover:bg-surface-2",
            railWidget === "codexbar" && "bg-surface-2 text-text",
          )}
        >
          <Activity className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="システム使用率を表示"
          title="システム使用率"
          aria-haspopup="dialog"
          aria-expanded={railWidget === "sysmon"}
          data-rail-widget-button="sysmon"
          onClick={(event) => {
            if (railWidget === "sysmon") {
              setRailWidget(null);
              return;
            }
            showRailWidget("sysmon", event.currentTarget);
          }}
          onMouseEnter={(event) => showRailWidget("sysmon", event.currentTarget)}
          onMouseLeave={scheduleRailWidgetHide}
          onFocus={(event) => {
            if (hoverCapable) showRailWidget("sysmon", event.currentTarget);
          }}
          onBlur={scheduleRailWidgetHide}
          className={cx(
            "inline-flex h-11 w-11 items-center justify-center rounded-xl hover:bg-surface-2",
            railWidget === "sysmon" && "bg-surface-2 text-text",
          )}
        >
          <Cpu className="h-4 w-4" />
        </button>
        <Link
          href="/settings"
          aria-label="設定"
          onClick={(event) => {
            event.preventDefault();
            openSettings();
          }}
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2"
        >
          <Settings className="h-4 w-4" />
        </Link>
      </div>
      {railWidget && (
        <div
          ref={railWidgetRef}
          role="dialog"
          aria-label={railWidget === "codexbar" ? "CodexBar 利用状況" : "システム使用率"}
          className="fixed z-50 w-[min(36rem,calc(100vw-6rem))] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-border/80 bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.12)]"
          style={{ bottom: railWidgetPos.bottom, left: railWidgetPos.left }}
          onMouseEnter={cancelRailWidgetHide}
          onMouseLeave={scheduleRailWidgetHide}
        >
          {railWidget === "codexbar" ? (
            <CodexBarWidget key="rail-codexbar" initialCollapsed={false} />
          ) : (
            <SystemMonitorWidget key="rail-sysmon" forceExpanded />
          )}
        </div>
      )}
      {projectTaskMenuProject && projectTaskMenu && (
        <div
          ref={projectTaskMenuRef}
          role="menu"
          aria-label={`${projectTaskMenuProject.name}のタスク`}
          className="fixed z-50 max-h-[min(22.5rem,calc(100vh-1rem))] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border/80 bg-surface/85 p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-xl"
          style={{ top: projectTaskMenu.top, left: projectTaskMenu.left }}
          onMouseEnter={cancelProjectTaskMenuHide}
          onMouseLeave={scheduleProjectTaskMenuHide}
          onFocus={cancelProjectTaskMenuHide}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              scheduleProjectTaskMenuHide();
            }
          }}
        >
          <div className="flex items-center gap-1 px-2 py-1">
            <ProjectIcon
              project={projectTaskMenuProject}
              className={cx(
                "flex h-7 w-7 items-center justify-center rounded-md text-xs font-medium",
                !projectTaskMenuProject.icon && "border",
              )}
            />
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-muted">
              {projectTaskMenuProject.name}
            </p>
            <button
              type="button"
              role="menuitem"
              aria-label={`${projectTaskMenuProject.name}の設定`}
              title="プロジェクト設定"
              onClick={() => {
                cancelProjectTaskMenuHide();
                setProjectTaskMenu(null);
                setProjectSettingsProject(projectTaskMenuProject);
              }}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label={`${projectTaskMenuProject.name}に新規タスクを作成`}
              title="新規タスク"
              onClick={() => {
                cancelProjectTaskMenuHide();
                setProjectTaskMenu(null);
                openProjectHome(projectTaskMenuProject.id);
              }}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          {projectTaskMenuTasks.length === 0 ? (
            <p className="px-2 py-2 text-xs text-faint">タスクなし</p>
          ) : (
            <div className="space-y-0.5">
              {projectTaskMenuTasks.map((task) => (
                <div key={task.id}>
                  <button
                    type="button"
                    role="menuitem"
                    aria-current={task.id === activeTaskId ? "page" : undefined}
                    title={task.title}
                    onClick={() => {
                      cancelProjectTaskMenuHide();
                      setProjectTaskMenu(null);
                      openTask(task.id);
                    }}
                    className={cx(
                      "flex min-w-0 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-muted hover:bg-surface-2 hover:text-text",
                      task.id === activeTaskId && "bg-surface-3 text-text",
                    )}
                  >
                    <TaskActivityIcon task={task} bot={(task.botId ?? task.supervisorBotId) ? botsById.get(task.botId ?? task.supervisorBotId!) : undefined} />
                    <span className="relative top-0.5 flex min-w-0 flex-1 flex-col items-start">
                      <span className="w-full truncate font-medium">{task.title}</span>
                      <span className="flex w-full min-w-0 items-center gap-1">
                        <span className="flex w-11 shrink-0 items-center">
                          <SessionLabelBadge labelId={task.label} className="w-full truncate text-center" />
                        </span>
                        <span className="w-16 shrink-0 truncate text-[10px] text-faint">{timeAgo(task.updatedAt)}</span>
                      </span>
                    </span>
                  </button>
                  <TaskProgressBar task={task} className="mx-3 mb-1" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      {mobileOpen && !mdUp && (
        <button
          type="button"
          aria-label="メニューを閉じる"
          className="fixed inset-0 z-[90] bg-black/40 md:hidden animate-[fade-in_0.15s_ease-out]"
          onClick={onClose}
        />
      )}
      <aside
        className={cx(
          "z-50 flex h-full shrink-0 flex-col border-r border-border bg-surface",
          "relative hidden md:flex",
        )}
        style={{ width: dragWidth ?? (collapsed ? COLLAPSED_WIDTH : width) }}
      >
        {mdUp ? (mode === "bot" ? botBody : collapsed ? collapsedRail : body) : null}
        {mdUp && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="サイドバーの幅を調整"
            className="absolute top-0 right-0 hidden h-full w-1 cursor-col-resize md:block"
            onPointerDown={(event) => {
              event.preventDefault();
              const startX = event.clientX;
              // 最小表示からドラッグを始めた場合はレール幅を基準にする（右へ引けば即広がる）。
              const startWidth = collapsed ? COLLAPSED_WIDTH : width;
              // ドラッグ中にサイドバー外のテキストが選択（テキストドラッグ判定）されないようにする。
              const previousUserSelect = document.body.style.userSelect;
              document.body.style.userSelect = "none";
              const onMove = (move: PointerEvent) => {
                const raw = startWidth + (move.clientX - startX);
                const next = resolveSidebarDrag(raw);
                // 端は常にカーソルへ追従させ、最小幅を下回っても縮み続ける。
                // 最小表示⇔通常表示の切替はしきい値で行い、離した時点で吸着させる。
                setDragWidth(Math.min(MAX_WIDTH, Math.max(COLLAPSED_WIDTH, raw)));
                if (next.width !== null) {
                  setWidth(next.width);
                  localStorage.setItem(WIDTH_KEY, String(next.width));
                }
                setCollapsed(next.collapsed);
                localStorage.setItem(COLLAPSED_KEY, next.collapsed ? "1" : "0");
              };
              const onUp = () => {
                setDragWidth(null);
                document.body.style.userSelect = previousUserSelect;
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
                window.removeEventListener("pointercancel", onUp);
                window.removeEventListener("blur", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
              window.addEventListener("pointercancel", onUp);
              window.addEventListener("blur", onUp);
            }}
          />
        )}
      </aside>
      {!mdUp && mobileOpen && (
        <aside
          data-mobile-drawer
          role="dialog"
          aria-modal="true"
          aria-label="ナビゲーション"
          className="fixed inset-y-0 left-0 z-[100] w-[min(20rem,85vw)] border-r border-border bg-surface md:hidden animate-[nav-in_0.18s_ease-out]"
        >
          {mode === "bot" ? botBody : body}
        </aside>
      )}
      {promotionTask && (
        <PromoteTaskDialog
          task={promotionTask}
          onClose={() => setPromotionTask(null)}
          onDone={(warning) => {
            if (warning) window.alert(warning);
            void refresh();
            notifyTasksChanged();
          }}
        />
      )}
      {currentProjectSettingsProject && (
        <ProjectSettingsDialog
          project={currentProjectSettingsProject}
          onClose={() => setProjectSettingsProject(null)}
          hostPlatform={health?.platform}
          onSetIcon={(file) => void setProjectIcon(currentProjectSettingsProject, file)}
          onSetIconData={(icon) => void setProjectIconData(currentProjectSettingsProject, icon)}
          onClearIcon={() => void clearProjectIcon(currentProjectSettingsProject)}
          onSetIconColor={(color) => void setProjectIconColor(currentProjectSettingsProject, color)}
          onMigrate={(destinationPath) => migrateProjectAction(currentProjectSettingsProject, destinationPath)}
          onMarkAllRead={() => markProjectTasksRead(currentProjectSettingsProject.id)}
          externalError={actionError}
        />
      )}
    </>
  );
});

export function Sidebar(props: SidebarProps) {
  const {
    activeTaskId: paneActiveTaskId,
    mdUp: paneMdUp,
    splitHostEnabled,
    retargetToUrl,
    dispatch,
  } = useTaskPanesNavigation();
  return (
    <SidebarView
      {...props}
      paneActiveTaskId={paneActiveTaskId}
      paneMdUp={paneMdUp}
      splitHostEnabled={splitHostEnabled}
      retargetToUrl={retargetToUrl}
      dispatch={dispatch}
    />
  );
}
