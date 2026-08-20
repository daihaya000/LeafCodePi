"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRight, Loader2, Menu, Plus, Settings, Trash2 } from "lucide-react";
import { AddProjectButton } from "@/components/AddProjectButton";
import { SystemMonitorWidget } from "@/components/sysmon/SystemMonitorWidget";
import { cx, timeAgo, ThemeToggle } from "@/components/ui";
import { notifyTasksChanged } from "@/lib/events";
import { getJson, sendJson } from "@/lib/client";
import type { HealthDto, ProjectDto, TaskSummary } from "@/lib/types";

const WIDTH_KEY = "webui.sidebar.width";
const COLLAPSED_KEY = "webui.sidebar.collapsed";
const EXPANDED_KEY = "webui.sidebar.expanded";
const DEFAULT_WIDTH = 240;
const COLLAPSED_WIDTH = 80;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;

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

export function Sidebar({
  mobileOpen,
  onClose,
}: {
  mobileOpen: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const [projectRes, taskRes, healthRes] = await Promise.allSettled([
      getJson<{ projects: ProjectDto[] }>("/api/projects"),
      getJson<{ tasks: TaskSummary[] }>("/api/tasks"),
      getJson<HealthDto>("/api/health"),
    ]);
    if (projectRes.status === "fulfilled") setProjects(projectRes.value.projects);
    if (taskRes.status === "fulfilled") setTasks(taskRes.value.tasks);
    if (healthRes.status === "fulfilled") setHealth(healthRes.value);
  }, []);

  useEffect(() => {
    try {
      const storedWidth = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(storedWidth) && storedWidth >= MIN_WIDTH) setWidth(storedWidth);
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
      const raw = localStorage.getItem(EXPANDED_KEY);
      if (raw) setExpanded(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore */
    }
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("webui:tasks-changed", onChange);
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      window.removeEventListener("webui:tasks-changed", onChange);
      clearInterval(timer);
    };
  }, [refresh]);

  const activeTaskId = pathname.startsWith("/task/") ? pathname.slice("/task/".length) : null;
  const tasksByProject = useMemo(() => {
    const map = new Map<string, TaskSummary[]>();
    for (const task of tasks) {
      const list = map.get(task.projectId) ?? [];
      list.push(task);
      map.set(task.projectId, list);
    }
    return map;
  }, [tasks]);

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const body = (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          aria-label={collapsed ? "サイドバーを展開" : "サイドバーを折りたたむ"}
          onClick={() => {
            const next = !collapsed;
            setCollapsed(next);
            localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
          }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-surface-2"
        >
          <Menu className="h-5 w-5 text-muted" />
        </button>
        {!collapsed && (
          <Link href="/" onClick={onClose} className="flex min-w-0 items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" alt="" className="h-6 w-6 rounded-[5px]" />
            <span className="truncate text-sm font-semibold">LeafCodePi</span>
          </Link>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {projects.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted">プロジェクトなし</p>
        ) : (
          <ul className="space-y-1">
            {projects.map((project) => {
              const children = tasksByProject.get(project.id) ?? [];
              const open = expanded.has(project.id) || children.some((task) => task.id === activeTaskId);
              const running = children.filter((task) => task.status === "working").length;
              return (
                <li key={project.id}>
                  <div className="flex items-center gap-0.5 rounded-lg hover:bg-surface-2">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggleExpanded(project.id)}
                      className="inline-flex h-8 w-6 items-center justify-center text-faint"
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
                      <span
                        className={cx(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[10px] font-medium",
                          projectIconTone(project.id),
                        )}
                      >
                        {projectInitial(project.name)}
                      </span>
                      {!collapsed && <span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>}
                      {!collapsed && running > 0 && (
                        <span className="inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-working px-1 text-[10px] font-semibold text-primary-fg">
                          {running}
                        </span>
                      )}
                    </button>
                    {!collapsed && (
                      <button
                        type="button"
                        aria-label={`${project.name}に新規タスクを作成`}
                        onClick={() => {
                          router.push(`/?projectId=${encodeURIComponent(project.id)}`);
                          onClose();
                        }}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:text-text"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {open && !collapsed && (
                    <ul className="mb-1 ml-5 space-y-0.5 border-l border-border pl-1.5">
                      {children.length === 0 ? (
                        <li className="px-2 py-1.5 text-[11px] text-muted">タスクなし</li>
                      ) : (
                        children.map((task) => (
                          <li key={task.id} className="group flex items-center rounded-lg">
                            <button
                              type="button"
                              onClick={() => {
                                router.push(`/task/${task.id}`);
                                onClose();
                              }}
                              className={cx(
                                "flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left",
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
                              aria-label="アーカイブ"
                              className="hidden h-7 w-7 items-center justify-center text-muted group-hover:inline-flex hover:text-text"
                              onClick={async () => {
                                await sendJson(`/api/tasks/${task.id}`, undefined, "DELETE");
                                notifyTasksChanged();
                                void refresh();
                              }}
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
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
      </div>

      <div className="shrink-0 border-t border-border p-2 pb-[env(safe-area-inset-bottom)]">
        {!collapsed && (
          <div className="mb-2">
            <SystemMonitorWidget />
          </div>
        )}
        {!collapsed && (
          <div className="mb-2 px-1">
            <AddProjectButton onAdded={() => void refresh()} className="w-full" />
          </div>
        )}
        <div className="flex items-center justify-between gap-1">
          {collapsed ? (
            <AddProjectButton variant="icon" icon="plus" className="h-11 w-11" onAdded={() => void refresh()} />
          ) : (
            <p className="px-2 text-[11px] text-muted">
              {health?.engineOk ? `Pi ${health.version ?? ""} · モデル ${health.modelCount}` : "Pi 未接続"}
            </p>
          )}
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
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                title={project.name}
                onClick={() => {
                  router.push(`/?projectId=${encodeURIComponent(project.id)}`);
                  onClose();
                }}
                className="inline-flex h-12 w-12 items-center justify-center rounded-xl p-1 hover:bg-surface-2"
              >
                <span
                  className={cx(
                    "flex h-full w-full items-center justify-center rounded-lg border text-base font-medium",
                    projectIconTone(project.id),
                  )}
                >
                  {projectInitial(project.name)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex w-full flex-col items-center gap-1 border-t border-border py-2">
        <AddProjectButton variant="icon" icon="plus" className="h-11 w-11" onAdded={() => void refresh()} />
        <Link href="/settings" aria-label="設定" className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2">
          <Settings className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="メニューを閉じる"
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={cx(
          "z-50 flex h-full shrink-0 flex-col border-r border-border bg-surface",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[min(20rem,85vw)] max-md:transition-transform",
          mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full",
          "relative hidden md:flex",
        )}
        style={{ width: collapsed ? COLLAPSED_WIDTH : width }}
      >
        {collapsed ? collapsedRail : body}
        {!collapsed && (
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
      <aside
        className={cx(
          "fixed inset-y-0 left-0 z-50 w-[min(20rem,85vw)] border-r border-border bg-surface md:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {body}
      </aside>
    </>
  );
}
