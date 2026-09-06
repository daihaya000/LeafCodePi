"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Archive,
  ArchiveRestore,
  ChevronRight,
  Cpu,
  Folder,
  FolderUp,
  Loader2,
  Menu,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { AddProjectButton } from "@/components/AddProjectButton";
import { CodexBarWidget } from "@/components/codexbar/CodexBarWidget";
import { SystemMonitorWidget } from "@/components/sysmon/SystemMonitorWidget";
import { useTaskPanes } from "@/components/shell/TaskPanesContext";
import { Button, cx, timeAgo, ThemeToggle } from "@/components/ui";
import { isTaskDrag, setTaskDragData } from "@/lib/task-drag";
import { notifyTasksChanged } from "@/lib/events";
import { getJson, sendJson } from "@/lib/client";
import { HOME_TAB_ID, SETTINGS_TAB_ID } from "@/lib/task-panes";
import { NO_PROJECT_NAME, type BotDto, type HealthDto, type RoomDto, type ProjectDto, type TaskSummary } from "@/lib/types";

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
const ARCHIVED_EXPANDED_KEY = "webui.sidebar.archived_expanded";
const DEFAULT_WIDTH = 240;
const COLLAPSED_WIDTH = 80;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const POLL_IDLE_MS = 12_000;
const POLL_WORKING_MS = 4_000;
const PROJECT_DRAG_MIME = "application/x-leafcode-project";
const HOVER_QUERY = "(hover: hover)";
const NO_PROJECT_GROUP_ID = "__leafcode_no_project__";

const PROJECT_ICON_TONES = [
  "border-danger/30 bg-danger-bg text-danger",
  "border-success/30 bg-success-bg text-success",
  "border-warning/30 bg-warning-bg text-warning",
  "border-accent/30 bg-accent/10 text-accent",
] as const;

function projectInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

/** 表示に影響するフィールドのみ比較（未変更なら参照を維持して再レンダーを防ぐ）。 */
export function sameTaskList(a: TaskSummary[], b: TaskSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (
      left.id !== right.id ||
      left.status !== right.status ||
      left.title !== right.title ||
      left.projectId !== right.projectId ||
      left.projectName !== right.projectName ||
      left.updatedAt !== right.updatedAt ||
      left.todoProgress?.completed !== right.todoProgress?.completed ||
      left.todoProgress?.total !== right.todoProgress?.total ||
      left.goalLoopSummary?.status !== right.goalLoopSummary?.status ||
      left.goalLoopSummary?.maxTurns !== right.goalLoopSummary?.maxTurns ||
      left.goalLoopSummary?.turnCount !== right.goalLoopSummary?.turnCount
    ) {
      return false;
    }
  }
  return true;
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
      left.icon !== right.icon
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

function projectIconTone(projectId: string): string {
  let hash = 0;
  for (const character of projectId) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return PROJECT_ICON_TONES[hash % PROJECT_ICON_TONES.length]!;
}

function ProjectIcon({ project, className }: { project: Pick<ProjectDto, "id" | "name" | "icon">; className?: string }) {
  return project.icon ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={project.icon} alt="" className={cx("rounded-md object-cover", className)} />
  ) : (
    <span className={cx(projectIconTone(project.id), className)}>{projectInitial(project.name)}</span>
  );
}

const PROJECT_ICON_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
const MODE_KEY = "leafcodepi.mode";
type AppMode = "code" | "bot";

function ModeSegment({ mode, onChange }: { mode: AppMode; onChange: (mode: AppMode) => void }) {
  return <div className="mx-1 mb-2 grid grid-cols-2 rounded-lg border border-border bg-surface-2 p-0.5">
    {(["code", "bot"] as const).map((item) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => onChange(item)} className={cx("rounded-md px-2 py-1.5 text-xs font-medium", mode === item ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}>{item === "code" ? "Code" : "ボット"}</button>)}
  </div>;
}

function BotSidebarBody({ onClose, onChangeMode, onSettings }: { onClose: () => void; onChangeMode: (mode: AppMode) => void; onSettings: () => void }) {
  const router = useRouter();
  const [bots, setBots] = useState<BotDto[]>([]);
  const [rooms, setRooms] = useState<RoomDto[]>([]);
  const [name, setName] = useState("");
  const [roomName, setRoomName] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void Promise.all([getJson<{ bots: BotDto[] }>("/api/bots"), getJson<{ rooms: RoomDto[] }>("/api/bots/rooms")])
      .then(([botResult, roomResult]) => { setBots(botResult.bots); setRooms(roomResult.rooms); })
      .catch(() => undefined);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  async function createBotEntry() { if (busy || !name.trim()) return; setBusy(true); try { const r = await sendJson<{ bot: BotDto }>("/api/bots", { name }); setName(""); router.push(`/bots/${r.bot.id}`); onClose(); } finally { setBusy(false); } }
  async function createRoomEntry() { if (busy || !roomName.trim()) return; setBusy(true); try { const r = await sendJson<{ room: RoomDto }>("/api/bots/rooms", { name: roomName }); setRoomName(""); router.push(`/bots/rooms/${r.room.id}`); onClose(); } finally { setBusy(false); } }
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleBots = normalizedQuery ? bots.filter((bot) => bot.name.toLocaleLowerCase().includes(normalizedQuery)) : bots;
  const visibleRooms = normalizedQuery ? rooms.filter((room) => room.name.toLocaleLowerCase().includes(normalizedQuery)) : rooms;
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <button type="button" aria-label="メニューを閉じる" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-surface-2"><Menu className="h-5 w-5 text-muted" /></button>
        <Link href="/bots" onClick={onClose} className="flex min-w-0 items-center gap-2"><img src="/icon.svg" alt="" className="h-6 w-6 rounded-[5px]" /><span className="truncate text-sm font-semibold">ボット</span></Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <ModeSegment mode="bot" onChange={onChangeMode} />
        <label className="mb-4 flex h-9 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-xs text-muted focus-within:border-accent"><Search className="h-3.5 w-3.5 shrink-0" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ボットやルームを検索" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" /></label>
        <div className="flex items-center justify-between px-2 py-1"><span className="text-xs font-medium text-muted">ルーム</span><Link href="/bots" onClick={onClose} className="text-xs text-accent">すべて</Link></div>
        <div className="mt-1 space-y-1">{visibleRooms.map((room) => <button key={room.id} type="button" onClick={() => { router.push(`/bots/rooms/${room.id}`); onClose(); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-surface-2"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success-bg text-xs text-success">#</span><span className="min-w-0 flex-1 truncate">{room.name}</span></button>)}{visibleRooms.length === 0 && <p className="px-2 py-2 text-xs text-muted">ルームはありません</p>}</div>
        <div className="mt-2 flex gap-1"><input value={roomName} onChange={(event) => setRoomName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createRoomEntry(); }} placeholder="新しいルーム" className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-xs outline-none focus:border-accent" /><button type="button" aria-label="ルームを作成" onClick={() => void createRoomEntry()} disabled={busy} className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent text-white disabled:opacity-50"><Plus className="h-3.5 w-3.5" /></button></div>
        <div className="mt-5 flex items-center justify-between px-2 py-1"><span className="text-xs font-medium text-muted">ボット</span><Link href="/bots" onClick={onClose} className="text-xs text-accent">すべて</Link></div>
        <div className="mt-1 space-y-1">{visibleBots.map((bot) => <button key={bot.id} type="button" onClick={() => { router.push(`/bots/${bot.id}`); onClose(); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-surface-2"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs text-accent">{Array.from(bot.name)[0] ?? "?"}</span><span className="min-w-0 flex-1 truncate">{bot.name}</span></button>)}{visibleBots.length === 0 && <p className="px-2 py-2 text-xs text-muted">ボットはありません</p>}</div>
        <div className="mt-2 flex gap-1"><input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createBotEntry(); }} placeholder="新しいボット" className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-xs outline-none focus:border-accent" /><button type="button" aria-label="ボットを作成" onClick={() => void createBotEntry()} disabled={busy} className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent text-white disabled:opacity-50"><Plus className="h-3.5 w-3.5" /></button></div>
      </div>
      <div className="shrink-0 border-t border-border p-2"><button type="button" onClick={onSettings} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-muted hover:bg-surface-2 hover:text-text"><Settings className="h-4 w-4" />設定</button></div>
    </div>
  );
}
function ProjectIconPicker({
  project,
  className,
  iconClassName,
  onFileChange,
  role,
}: {
  project: Pick<ProjectDto, "id" | "name" | "icon">;
  className?: string;
  iconClassName?: string;
  onFileChange: (file: File | null) => void;
  role?: "menuitem";
}) {
  return (
    <label
      role={role}
      title={`${project.name}のアイコンを設定`}
      className={cx(
        "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md text-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-primary",
        className,
      )}
    >
      <ProjectIcon project={project} className={iconClassName} />
      <input
        type="file"
        aria-label={`${project.name}のアイコンを設定`}
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

function countRunningTasks(tasks: TaskSummary[]): number {
  return tasks.filter((task) => task.status === "working").length;
}

/** 最新の更新時刻順に表示する（同時刻は元の順序を保つ）。 */
export function tasksForSidebar(tasks: TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** API が新しい順に返すプロジェクト内の、最新の進行中タスクを返す。 */
export function latestWorkingTask(tasks: TaskSummary[], projectId: string): TaskSummary | null {
  return tasks.find((task) => task.projectId === projectId && task.status === "working") ?? null;
}

const LIVE_GOAL_LOOP_STATUSES = new Set(["queued", "running", "verifying_completed"]);

function promotionBlocked(task: TaskSummary): boolean {
  return task.status === "working" || LIVE_GOAL_LOOP_STATUSES.has(task.goalLoopSummary?.status ?? "");
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
  if (!loop || !LIVE_GOAL_LOOP_STATUSES.has(loop.status)) return null;

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

export function TaskProgressBar({
  task,
  className,
}: {
  task: Pick<TaskSummary, "title" | "todoProgress" | "goalLoopSummary">;
  className?: string;
}) {
  return task.goalLoopSummary && LIVE_GOAL_LOOP_STATUSES.has(task.goalLoopSummary.status) ? (
    <GoalLoopProgressBar task={task} className={className} />
  ) : (
    <TodoProgressBar task={task} className={className} />
  );
}

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

  async function browse() {
    setBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ path?: string }>(
        "/api/browse/dirs",
        {},
        "POST",
        { timeoutMs: 135_000 },
      );
      if (result.path) setPath(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "フォルダー選択に失敗しました");
    } finally {
      setBusy(false);
    }
  }

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
      setError(err instanceof Error ? err.message : "プロジェクトへの昇進に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-3 backdrop-blur-[2px] sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="promote-task-title"
        className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-2xl"
      >
        <div className="border-b border-border px-4 py-3 sm:px-5">
          <h2 id="promote-task-title" className="text-sm font-semibold">プロジェクトへ昇進</h2>
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
            <Button size="sm" onClick={() => void browse()} busy={busy}>参照</Button>
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

type SidebarProps = {
  mobileOpen: boolean;
  onClose: () => void;
};

type SidebarPaneProps = {
  paneActiveTaskId: string | null;
  paneMdUp: boolean;
  splitHostEnabled: boolean;
  retargetToUrl: (taskId: string) => void;
};

const SidebarView = memo(function SidebarView({
  mobileOpen,
  onClose,
  paneActiveTaskId,
  paneMdUp,
  splitHostEnabled,
  retargetToUrl,
}: SidebarProps & SidebarPaneProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mode, setMode] = useState<AppMode>("code");
  const mdUp = useIsMdUp();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<ProjectDto[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<TaskSummary[]>([]);
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [hoverCapable, setHoverCapable] = useState(
    () =>
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia(HOVER_QUERY).matches,
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [projectOrder, setProjectOrder] = useState<string[]>(() => loadProjectOrder());
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null);
  const [keyboardDraggedProjectId, setKeyboardDraggedProjectId] = useState<string | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);
  const [projectTaskMenu, setProjectTaskMenu] = useState<ProjectTaskMenuState | null>(null);
  const [promotionTask, setPromotionTask] = useState<TaskSummary | null>(null);
  const [railWidget, setRailWidget] = useState<RailWidget | null>(null);
  const [railWidgetPos, setRailWidgetPos] = useState({ bottom: 0, left: 0 });
  const taskDragActiveRef = useRef(false);
  const refreshGenRef = useRef(0);
  const projectTaskMenuHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectTaskMenuRef = useRef<HTMLDivElement | null>(null);
  const railWidgetHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const railWidgetRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    const gen = ++refreshGenRef.current;
    const [projectRes, taskRes, healthRes] = await Promise.allSettled([
      getJson<{ projects: ProjectDto[] }>("/api/projects?archived=1"),
      getJson<{ tasks: TaskSummary[] }>("/api/tasks?archived=1"),
      getJson<HealthDto>("/api/health"),
    ]);
    // Drop stale responses so a slow poll cannot overwrite a newer refresh.
    if (gen !== refreshGenRef.current) return;
    if (taskDragActiveRef.current) return;
    if (projectRes.status === "fulfilled") {
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
      const nextArchivedTasks = taskRes.value.tasks.filter((task) => task.status === "archived");
      setTasks((current) => (sameTaskList(current, nextTasks) ? current : nextTasks));
      setArchivedTasks((current) =>
        sameTaskList(current, nextArchivedTasks) ? current : nextArchivedTasks,
      );
    }
    if (healthRes.status === "fulfilled") {
      setHealth((current) => (sameHealth(current, healthRes.value) ? current : healthRes.value));
    }
  }, []);

  const hasWorking = useMemo(
    () => tasks.some((task) => task.status === "working"),
    [tasks],
  );

  useEffect(() => {
    try {
      const storedMode = localStorage.getItem(MODE_KEY);
      if (storedMode === "bot" || storedMode === "code") setMode(storedMode);
      if (pathname.startsWith("/bots")) setMode("bot");
      const storedWidth = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(storedWidth) && storedWidth >= MIN_WIDTH) setWidth(storedWidth);
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
      setExpanded(loadExpanded());
      setArchivedExpanded(localStorage.getItem(ARCHIVED_EXPANDED_KEY) === "1");
    } catch {
      /* ignore */
    }
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("webui:tasks-changed", onChange);
    return () => {
      window.removeEventListener("webui:tasks-changed", onChange);
    };
  }, [refresh, pathname]);

  const changeMode = useCallback((next: AppMode) => {
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* ignore */ }
    router.push(next === "bot" ? "/bots" : "/");
    onClose();
  }, [onClose, router]);

  useEffect(() => {
    const intervalMs = hasWorking ? POLL_WORKING_MS : POLL_IDLE_MS;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, hasWorking]);

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

  const tasksByProject = useMemo(() => {
    const map = new Map<string | null, TaskSummary[]>();
    for (const task of tasks) {
      const list = map.get(task.projectId) ?? [];
      list.push(task);
      map.set(task.projectId, list);
    }
    for (const [projectId, list] of map) {
      map.set(projectId, tasksForSidebar(list));
    }
    return map;
  }, [tasks]);
  const noProjectTasks = tasksByProject.get(null) ?? [];
  const activeTask = activeTaskId === null ? undefined : tasks.find((task) => task.id === activeTaskId);
  const activeGroupId = activeTask
    ? activeTask.projectId ?? NO_PROJECT_GROUP_ID
    : null;

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

  const archivedGroups = useMemo(() => {
    const groups = new Map<string, { name: string; tasks: TaskSummary[] }>();
    for (const task of archivedTasks) {
      const key = task.projectId ? `project:${task.projectId}` : "no-project";
      const group = groups.get(key) ?? { name: task.projectName, tasks: [] };
      group.tasks.push(task);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => ({
      key,
      name: group.name,
      tasks: group.tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }));
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

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveExpanded(next);
      return next;
    });
  }

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

  async function runAction(key: string, action: () => Promise<unknown>) {
    if (actionBusyKey) return;
    setActionBusyKey(key);
    try {
      await action();
    } catch (err) {
      console.error("[sidebar] action failed", err);
    } finally {
      setActionBusyKey(null);
      void refresh();
      notifyTasksChanged();
    }
  }

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

  async function setProjectIcon(project: ProjectDto, file: File | null) {
    if (!file) return;
    if (!file.type.match(/^image\/(png|jpeg|gif|webp)$/)) {
      window.alert("PNG・JPEG・GIF・WebP の画像を選択してください。");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      window.alert("2 MB以下の画像を選択してください。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      void runAction(`icon:${project.id}`, () =>
        sendJson("/api/projects", { id: project.id, icon: String(reader.result) }, "PATCH"),
      );
    };
    reader.readAsDataURL(file);
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

  function renderTaskList(children: TaskSummary[]) {
    return (
      <ul
        className={cx(
          "mb-1 ml-5 space-y-0.5 border-l border-border pl-1.5",
          children.length >= 5 && "max-h-72 overflow-y-auto",
        )}
      >
        {children.length === 0 ? (
          <li className="px-2 py-1.5 text-[11px] text-muted">タスクなし</li>
        ) : (
          children.map((task) => (
            <li key={task.id} className="group rounded-lg">
              <div className="flex items-center">
                <button
                  type="button"
                  draggable={mdUp}
                  onDragStart={(event) => {
                    taskDragActiveRef.current = true;
                    event.dataTransfer.effectAllowed = "move";
                    setTaskDragData(event.dataTransfer, task.id);
                  }}
                  onClick={() => openTask(task.id)}
                  className={cx(
                    "flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left md:min-h-8",
                    task.id === activeTaskId ? "bg-surface-3 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
                  )}
                >
                  {task.status === "working" ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-working" />
                  ) : (
                    <span
                      className={cx(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        task.status === "error" ? "bg-danger" : "bg-faint",
                      )}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{task.title}</span>
                  <span className="shrink-0 text-[10px] text-muted">{timeAgo(task.updatedAt)}</span>
                </button>
                {task.projectId === null && (
                  <button
                    type="button"
                    aria-label={promotionBlocked(task) ? `「${task.title}」は実行中のため昇進できません` : `「${task.title}」をプロジェクトへ昇進`}
                    title={promotionBlocked(task) ? "実行中のタスクは昇進できません" : "プロジェクトへ昇進"}
                    disabled={actionBusyKey !== null || promotionBlocked(task)}
                    onClick={() => setPromotionTask(task)}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40 md:h-6 md:w-6"
                  >
                    <FolderUp className="h-3 w-3" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`「${task.title}」をアーカイブ`}
                  title="タスクをアーカイブ"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text md:h-6 md:w-6"
                  onClick={() =>
                    void runAction(`archive:${task.id}`, () =>
                      sendJson(`/api/tasks/${task.id}`, undefined, "DELETE"),
                    )
                  }
                >
                  <Archive className="h-3 w-3" />
                </button>
              </div>
              <TaskProgressBar task={task} className="mx-8 pb-1.5 md:mx-7" />
            </li>
          ))
        )}
      </ul>
    );
  }

  // `collapsed` はデスクトップ専用のレール表示（collapsedRail）用。body は
  // デスクトップでは !collapsed のときだけ描画され、モバイルドロワーは常に全幅なので、
  // body 内で collapsed を参照してはいけない（参照すると 240px 幅のまま
  // プロジェクト名もタスクもフッターも消えたドロワーになる）。
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <ModeSegment mode={mode} onChange={changeMode} />
        <span className="sr-only">
          ドラッグしてプロジェクトを並べ替えます。キーボードではスペースで開始し、上下矢印で移動、スペースで終了します。
        </span>
        <span role="status" aria-live="polite" className="sr-only">
          {reorderAnnouncement}
        </span>
        <ul className="space-y-1">
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
                {countRunningTasks(noProjectTasks) > 0 && (
                  <span className="inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-working px-1 text-[10px] font-semibold text-primary-fg">
                    {countRunningTasks(noProjectTasks)}
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
            {noProjectOpen && renderTaskList(noProjectTasks)}
          </li>
            {orderedProjects.map((project) => {
              const children = tasksByProject.get(project.id) ?? [];
              const open = expanded.has(project.id);
              const running = countRunningTasks(children);
              return (
                <li key={project.id}>
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
                    <ProjectIconPicker
                      project={project}
                      className="h-11 w-11 hover:bg-surface-2 hover:text-text md:h-8 md:w-8"
                      iconClassName="flex h-5 w-5 items-center justify-center rounded-md border text-[10px] font-medium"
                      onFileChange={(file) => void setProjectIcon(project, file)}
                    />
                    <button
                      type="button"
                      onClick={() => openProject(project.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>
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
                      aria-label={`${project.name}をアーカイブ`}
                      title="プロジェクトをアーカイブ"
                      disabled={actionBusyKey !== null}
                      onClick={() => void archiveProjectAction(project)}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted hover:bg-danger-bg hover:text-danger md:h-8 md:w-8"
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </button>
                  </div>
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
            <span className="tabular-nums text-[10px] text-muted">{archivedTasks.length}</span>
            <ChevronRight
              className={cx("h-3 w-3 shrink-0 transition-transform", archivedExpanded && "rotate-90")}
              aria-hidden="true"
            />
          </button>
          {archivedExpanded && (
            <ul className="mb-1 ml-2 space-y-0.5 border-l border-border pl-1.5">
              {archivedGroups.length === 0 ? (
                <li className="px-2 py-1.5 text-[11px] text-muted">
                  アーカイブされたタスクはありません
                </li>
              ) : (
                archivedGroups.map((group) => (
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
                              <span className="min-w-0 flex-1 truncate text-xs font-medium">{task.title}</span>
                              <span className="shrink-0 text-[10px] text-muted">{timeAgo(task.updatedAt)}</span>
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
          {archivedProjects.length > 0 && (
            <div className="mt-2">
              <p className="px-2 py-1 text-[11px] font-medium text-muted">アーカイブ済みプロジェクト</p>
              <ul className="ml-2 space-y-0.5 border-l border-border pl-1.5">
                {archivedProjects.map((project) => (
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
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border p-2 pb-[env(safe-area-inset-bottom)]">
        <div className="mt-2">
          <CodexBarWidget />
        </div>
        <div className="mt-2">
          <SystemMonitorWidget />
        </div>
        <div className="mt-2 flex items-center justify-between gap-1">
          <p className="px-2 text-[11px] text-muted">
            {health?.engineOk ? `Pi ${health.version ?? ""} · モデル ${health.modelCount}` : "Pi 未接続"}
          </p>
          <div className="flex items-center">
            <ThemeToggle />
            <Link
              href="/settings"
              aria-label="設定"
              onClick={(event) => {
                event.preventDefault();
                openSettings();
              }}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
            >
              <Settings className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );

  const projectTaskMenuProject = projectTaskMenu
    ? projects.find((project) => project.id === projectTaskMenu.projectId)
    : undefined;
  const projectTaskMenuTasks = projectTaskMenuProject
    ? (tasksByProject.get(projectTaskMenuProject.id) ?? []).slice(0, 20)
    : [];

  const botBody = <BotSidebarBody onClose={onClose} onChangeMode={changeMode} onSettings={openSettings} />;

  const collapsedRail = (
    <div className="flex h-full w-20 flex-col items-center bg-surface">
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
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ul className="flex flex-col items-center gap-3">
          <li>
            <button
              type="button"
              title={NO_PROJECT_NAME}
              aria-label={`${NO_PROJECT_NAME}を選択`}
              onClick={openNoProject}
              className="group relative inline-flex h-12 w-12 items-center justify-center rounded-xl p-1 hover:bg-surface-2"
            >
              <span className="flex h-full w-full items-center justify-center rounded-lg border border-border bg-surface-2 text-muted transition-transform group-hover:scale-105">
                <Folder className="h-5 w-5" />
              </span>
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
            const tapOpensMenu = !hoverCapable && projectTasks.length > 0;
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
                  className="group relative inline-flex h-12 w-12 items-center justify-center rounded-xl p-1 hover:bg-surface-2"
                >
                  <ProjectIcon
                    project={project}
                    className="flex h-full w-full items-center justify-center rounded-lg border text-base font-medium transition-transform group-hover:scale-105"
                  />
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
            <ProjectIconPicker
              project={projectTaskMenuProject}
              role="menuitem"
              className="h-8 w-8 hover:bg-surface-2 hover:text-text"
              iconClassName="flex h-7 w-7 items-center justify-center border text-xs font-medium"
              onFileChange={(file) => void setProjectIcon(projectTaskMenuProject, file)}
            />
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-muted">
              {projectTaskMenuProject.name}
            </p>
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
                    <span
                      aria-hidden="true"
                      className={cx(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        task.status === "working"
                          ? "bg-working"
                          : task.status === "error"
                            ? "bg-danger"
                            : "bg-faint",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
                    <span className="shrink-0 text-[10px] text-faint">{timeAgo(task.updatedAt)}</span>
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
          className="fixed inset-0 z-40 bg-black/40 md:hidden animate-[fade-in_0.15s_ease-out]"
          onClick={onClose}
        />
      )}
      <aside
        className={cx(
          "z-50 flex h-full shrink-0 flex-col border-r border-border bg-surface",
          "relative hidden md:flex",
        )}
        style={{ width: collapsed ? COLLAPSED_WIDTH : width }}
      >
        {mdUp ? (collapsed ? collapsedRail : mode === "bot" ? botBody : body) : null}
        {mdUp && !collapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            className="absolute top-0 right-0 hidden h-full w-1 cursor-col-resize md:block"
            onPointerDown={(event) => {
              const startX = event.clientX;
              const startWidth = width;
              const onMove = (move: PointerEvent) => {
                const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (move.clientX - startX)));
                setWidth(next);
                localStorage.setItem(WIDTH_KEY, String(next));
              };
              const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
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
          className="fixed inset-y-0 left-0 z-50 w-[min(20rem,85vw)] border-r border-border bg-surface md:hidden animate-[nav-in_0.18s_ease-out]"
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
    </>
  );
});

export function Sidebar(props: SidebarProps) {
  const {
    activeTaskId: paneActiveTaskId,
    mdUp: paneMdUp,
    splitHostEnabled,
    retargetToUrl,
  } = useTaskPanes();
  return (
    <SidebarView
      {...props}
      paneActiveTaskId={paneActiveTaskId}
      paneMdUp={paneMdUp}
      splitHostEnabled={splitHostEnabled}
      retargetToUrl={retargetToUrl}
    />
  );
}
