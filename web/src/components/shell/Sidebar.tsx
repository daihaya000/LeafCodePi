"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Archive,
  Image as ImageIcon,
  ImageOff,
  ArchiveRestore,
  ChevronRight,
  Cpu,
  Loader2,
  Menu,
  Plus,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { AddProjectButton } from "@/components/AddProjectButton";
import { CollaborationBadge } from "@/components/CollaborationStatus";
import { CodexBarWidget } from "@/components/codexbar/CodexBarWidget";
import { SystemMonitorWidget } from "@/components/sysmon/SystemMonitorWidget";
import { useTaskPanes } from "@/components/shell/TaskPanesContext";
import { cx, timeAgo, ThemeToggle } from "@/components/ui";
import { isTaskDrag, setTaskDragData } from "@/lib/task-drag";
import { notifyTasksChanged } from "@/lib/events";
import { getJson, sendJson } from "@/lib/client";
import type { HealthDto, ProjectDto, TaskSummary } from "@/lib/types";
import type { CollaborationRoomSummary } from "@/lib/collaboration-room";

type ProjectTaskMenuState = {
  projectId: string;
  top: number;
  left: number;
};

type RailWidget = "codexbar" | "sysmon";

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

const PROJECT_ICON_TONES = [
  "border-danger/30 bg-danger-bg text-danger",
  "border-success/30 bg-success-bg text-success",
  "border-warning/30 bg-warning-bg text-warning",
  "border-accent/30 bg-accent/10 text-accent",
] as const;

function projectInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
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

function countRunningTasks(tasks: TaskSummary[]): number {
  return tasks.filter((task) => task.status === "working").length;
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

export function Sidebar({
  mobileOpen,
  onClose,
}: {
  mobileOpen: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const mdUp = useIsMdUp();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<ProjectDto[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<TaskSummary[]>([]);
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [collaborationRooms, setCollaborationRooms] = useState<Record<string, CollaborationRoomSummary>>({});
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
  const [railWidget, setRailWidget] = useState<RailWidget | null>(null);
  const [railWidgetPos, setRailWidgetPos] = useState({ bottom: 0, left: 0 });
  const taskDragActiveRef = useRef(false);
  const projectTaskMenuHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectTaskMenuRef = useRef<HTMLDivElement | null>(null);
  const railWidgetHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const railWidgetRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    const [projectRes, taskRes, archivedRes, archivedProjectsRes, healthRes, collaborationRes] = await Promise.allSettled([
      getJson<{ projects: ProjectDto[] }>("/api/projects"),
      getJson<{ tasks: TaskSummary[] }>("/api/tasks"),
      getJson<{ tasks: TaskSummary[] }>("/api/tasks?archived=1"),
      getJson<{ projects: ProjectDto[] }>("/api/projects?archived=1"),
      getJson<HealthDto>("/api/health"),
      getJson<{ rooms: Record<string, CollaborationRoomSummary> }>("/api/collaboration"),
    ]);
    if (taskDragActiveRef.current) return;
    if (projectRes.status === "fulfilled") setProjects(projectRes.value.projects);
    if (taskRes.status === "fulfilled") setTasks(taskRes.value.tasks);
    if (archivedRes.status === "fulfilled") {
      setArchivedTasks(archivedRes.value.tasks.filter((task) => task.status === "archived"));
    }
    if (archivedProjectsRes.status === "fulfilled") {
      setArchivedProjects(archivedProjectsRes.value.projects.filter((project) => project.archived));
    }
    if (healthRes.status === "fulfilled") setHealth(healthRes.value);
    if (collaborationRes.status === "fulfilled") setCollaborationRooms(collaborationRes.value.rooms);
  }, []);

  const hasWorking = useMemo(
    () => tasks.some((task) => task.status === "working"),
    [tasks],
  );

  useEffect(() => {
    try {
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
  }, [refresh]);

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
  const { activeTaskId: paneActiveTaskId, mdUp: paneMdUp } = useTaskPanes();
  const pathnameTaskId = pathname.startsWith("/task/") ? pathname.slice("/task/".length) : null;
  const activeTaskId = paneMdUp ? paneActiveTaskId : pathnameTaskId;
  const tasksByProject = useMemo(() => {
    const map = new Map<string, TaskSummary[]>();
    for (const task of tasks) {
      const list = map.get(task.projectId) ?? [];
      list.push(task);
      map.set(task.projectId, list);
    }
    return map;
  }, [tasks]);

  const archivedGroups = useMemo(() => {
    const groups = new Map<string, TaskSummary[]>();
    for (const task of archivedTasks) {
      const list = groups.get(task.projectName) ?? [];
      list.push(task);
      groups.set(task.projectName, list);
    }
    return [...groups.entries()].map(([name, list]) => ({
      key: name,
      name,
      tasks: list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
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
    (sourceId: string, targetId: string, placement: "before" | "after" = "before"): boolean => {
      if (sourceId === targetId) return false;
      const nextOrder = orderedProjects.map((project) => project.id);
      const sourceIndex = nextOrder.indexOf(sourceId);
      if (sourceIndex < 0 || nextOrder.indexOf(targetId) < 0) return false;
      const [moved] = nextOrder.splice(sourceIndex, 1);
      if (!moved) return false;
      const targetIndex = nextOrder.indexOf(targetId);
      nextOrder.splice(targetIndex + (placement === "after" ? 1 : 0), 0, moved);
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
      event.preventDefault();
      const sourceId = projectDragIdFromDataTransfer(event.dataTransfer) || draggedProjectId;
      if (sourceId && reorderProjects(sourceId, targetId)) {
        const source = orderedProjects.find((project) => project.id === sourceId);
        const target = orderedProjects.find((project) => project.id === targetId);
        if (source && target) {
          setReorderAnnouncement(`${source.name}を${target.name}の前に移動しました`);
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
    if (!projectId) return;
    await runAction(`destroy-group:${group.key}`, () =>
      sendJson(`/api/tasks?projectId=${encodeURIComponent(projectId)}`, undefined, "DELETE"),
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
    if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024) {
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

  async function clearProjectIcon(project: ProjectDto) {
    await runAction(`icon:${project.id}`, () =>
      sendJson("/api/projects", { id: project.id, icon: null }, "PATCH"),
    );
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <span className="sr-only">
          ドラッグしてプロジェクトを並べ替えます。キーボードではスペースで開始し、上下矢印で移動、スペースで終了します。
        </span>
        <span role="status" aria-live="polite" className="sr-only">
          {reorderAnnouncement}
        </span>
        {projects.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted">プロジェクトなし</p>
        ) : (
          <ul className="space-y-1">
            {orderedProjects.map((project) => {
              const children = tasksByProject.get(project.id) ?? [];
              const open = expanded.has(project.id) || children.some((task) => task.id === activeTaskId);
              const running = countRunningTasks(children);
              return (
                <li key={project.id}>
                  <div
                    className={cx(
                      "flex items-center gap-0.5 rounded-lg",
                      dragOverProjectId === project.id && draggedProjectId !== project.id && "bg-surface-3",
                    )}
                  >
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={`${project.name}を${open ? "折りたたむ" : "展開"}`}
                      draggable={orderedProjects.length > 1}
                      onDragStart={(event) => handleProjectDragStart(event, project.id)}
                      onDragOver={(event) => handleProjectDragOver(event, project.id)}
                      onDrop={(event) => handleProjectDrop(event, project.id)}
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
                    <button
                      type="button"
                      onClick={() => {
                        router.push(`/?projectId=${encodeURIComponent(project.id)}`);
                        onClose();
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left"
                    >
                      <ProjectIcon
                        project={project}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[10px] font-medium"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>
                      {running > 0 && (
                        <span className="inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-working px-1 text-[10px] font-semibold text-primary-fg">
                          {running}
                        </span>
                      )}
                    </button>
                    <CollaborationBadge
                      projectId={project.id}
                      room={collaborationRooms[project.id]}
                      onResolved={() => void refresh()}
                    />
                    <button
                      type="button"
                      aria-label={`${project.name}に新規タスクを作成`}
                      title="新規タスク"
                      onClick={() => {
                        router.push(`/?projectId=${encodeURIComponent(project.id)}`);
                        onClose();
                      }}
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
                  {open && (
                    <ul className="mb-1 ml-5 space-y-0.5 border-l border-border pl-1.5">
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
                                onClick={() => {
                                  router.push(`/task/${task.id}`);
                                  onClose();
                                }}
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
                            <TodoProgressBar task={task} className="mx-8 pb-1.5 md:mx-7" />
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}

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
                              onClick={() => {
                                router.push(`/task/${task.id}`);
                                onClose();
                              }}
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
                        onClick={() => {
                          router.push(`/?projectId=${encodeURIComponent(project.id)}`);
                          onClose();
                        }}
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
        <div className="mb-2 px-1">
          <AddProjectButton onAdded={() => void refresh()} className="w-full" />
        </div>
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
              onClick={onClose}
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
          {projects.map((project) => {
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
                      router.push(`/?projectId=${encodeURIComponent(project.id)}`);
                      onClose();
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
        <Link href="/settings" aria-label="設定" className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2">
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
            <ProjectIcon project={projectTaskMenuProject} className="h-7 w-7 shrink-0 border text-xs font-medium" />
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-muted">
              {projectTaskMenuProject.name}
            </p>
            <label
              role="menuitem"
              title="プロジェクトアイコンを設定"
              aria-label="プロジェクトアイコンを設定"
              className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
            >
              <ImageIcon className="h-4 w-4" />
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="sr-only"
                onChange={(event) => {
                  void setProjectIcon(projectTaskMenuProject, event.target.files?.[0] ?? null);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            {projectTaskMenuProject.icon && (
              <button
                type="button"
                role="menuitem"
                aria-label="プロジェクトアイコンを削除"
                title="プロジェクトアイコンを削除"
                onClick={() => void clearProjectIcon(projectTaskMenuProject)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
              >
                <ImageOff className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              aria-label={`${projectTaskMenuProject.name}に新規タスクを作成`}
              title="新規タスク"
              onClick={() => {
                cancelProjectTaskMenuHide();
                setProjectTaskMenu(null);
                router.push(`/?projectId=${encodeURIComponent(projectTaskMenuProject.id)}`);
                onClose();
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
                      router.push(`/task/${encodeURIComponent(task.id)}`);
                      onClose();
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
                  <TodoProgressBar task={task} className="mx-3 mb-1" />
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
        {mdUp ? (collapsed ? collapsedRail : body) : null}
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
          {body}
        </aside>
      )}
    </>
  );
}
