import { existsSync, statSync } from "node:fs";
import { readSessionWorkSummary } from "@/lib/direct-session";
import type { TodoDto, TodoProgressDto, TodoStatus } from "@/lib/types";
import { todoProgressFromTodos } from "@/lib/pi/todowrite-state";

const DISK_TODO_PROGRESS_CACHE_MAX = 2048;

type DiskTodoProgressCacheEntry = {
  mtimeMs: number;
  size: number;
  value: TodoProgressDto | undefined;
};

const diskTodoProgressCache = new Map<string, DiskTodoProgressCacheEntry>();

function isTodoStatus(value: string): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function progressFromWorkSummaryTodos(
  todos: readonly { content: string; status: string }[],
): TodoProgressDto | undefined {
  const normalized: TodoDto[] = todos.flatMap((todo, index) => {
    if (!todo.content.trim() || !isTodoStatus(todo.status)) return [];
    return [{
      id: `disk-todo-${index + 1}`,
      content: todo.content,
      status: todo.status,
      priority: "medium" as const,
    }];
  });
  return todoProgressFromTodos(normalized);
}

function cacheDiskTodoProgress(sessionFile: string, entry: DiskTodoProgressCacheEntry): void {
  if (
    diskTodoProgressCache.size >= DISK_TODO_PROGRESS_CACHE_MAX &&
    !diskTodoProgressCache.has(sessionFile)
  ) {
    const oldest = diskTodoProgressCache.keys().next().value;
    if (oldest !== undefined) diskTodoProgressCache.delete(oldest);
  }
  diskTodoProgressCache.set(sessionFile, entry);
}

/**
 * Idle Sidebar / ready Code cards after cutover: read Todo bars from the shared
 * session file without Pi SessionManager.open and without an omit GET stampede.
 * Working tasks still need Backend omit for live activity / freshest progress.
 */
export function readDiskTodoProgress(
  sessionFile: string | null | undefined,
): TodoProgressDto | undefined {
  if (!sessionFile || !existsSync(sessionFile)) return undefined;
  try {
    const stats = statSync(sessionFile);
    if (!stats.isFile()) return undefined;
    const cached = diskTodoProgressCache.get(sessionFile);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.value;
    }
    const value = progressFromWorkSummaryTodos(readSessionWorkSummary(sessionFile).todos);
    cacheDiskTodoProgress(sessionFile, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      value,
    });
    return value;
  } catch {
    diskTodoProgressCache.delete(sessionFile);
    return undefined;
  }
}

/** Test helper: drop the mtime cache between cases. */
export function clearDiskTodoProgressCacheForTests(): void {
  diskTodoProgressCache.clear();
}
