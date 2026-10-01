import { forwardTaskDetail } from "@/lib/backend-forward";
import type { TodoDto, TodoProgressDto } from "@/lib/types";
import { todoProgressFromTodos } from "@/lib/pi/todowrite-state";

/** Prefer the owner's summary field; fall back to projecting `todos` from an omit detail. */
export function todoProgressFromDetail(
  detail: Record<string, unknown> | null | undefined,
): TodoProgressDto | undefined {
  if (!detail) return undefined;
  const direct = detail.todoProgress;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as TodoProgressDto;
  }
  if (Array.isArray(detail.todos)) {
    return todoProgressFromTodos(detail.todos as TodoDto[]);
  }
  return undefined;
}

/** Running tool label the owner stamped on omit/page detail (see sessionSnapshotFields). */
export function activityFromDetail(
  detail: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!detail) return undefined;
  const activity = detail.activity;
  return typeof activity === "string" && activity.trim() ? activity.slice(0, 80) : undefined;
}

export type RemoteCodeProgress = {
  todoProgress?: TodoProgressDto;
  activity?: string;
};

const inflight = new Map<string, Promise<RemoteCodeProgress>>();

/**
 * One omit detail read per task for cutover peeks: Todo bars and the live tool label
 * share the same Backend GET. Overlapping sidebar / code-requests polls coalesce.
 */
export async function fetchRemoteCodeProgress(taskId: string): Promise<RemoteCodeProgress> {
  const existing = inflight.get(taskId);
  if (existing) return existing;
  const promise = (async (): Promise<RemoteCodeProgress> => {
    try {
      const result = await forwardTaskDetail(taskId, { messages: "omit" });
      if (!result.ok) return {};
      const todoProgress = todoProgressFromDetail(result.detail);
      const activity = activityFromDetail(result.detail);
      return {
        ...(todoProgress ? { todoProgress } : {}),
        ...(activity ? { activity } : {}),
      };
    } catch {
      return {};
    }
  })().finally(() => {
    inflight.delete(taskId);
  });
  inflight.set(taskId, promise);
  return promise;
}

/** One omit detail read per task; overlapping peek/sidebar polls share the in-flight GET. */
export async function fetchRemoteTodoProgress(taskId: string): Promise<TodoProgressDto | undefined> {
  return (await fetchRemoteCodeProgress(taskId)).todoProgress;
}

/** Bound concurrency so a large working set cannot stampede the Backend. */
export async function fetchRemoteTodoProgressMany(
  taskIds: readonly string[],
  concurrency = 4,
): Promise<Map<string, TodoProgressDto>> {
  const unique = [...new Set(taskIds.filter(Boolean))];
  const out = new Map<string, TodoProgressDto>();
  if (unique.length === 0) return out;
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (next < unique.length) {
      const index = next;
      next += 1;
      const taskId = unique[index]!;
      const progress = await fetchRemoteTodoProgress(taskId);
      if (progress) out.set(taskId, progress);
    }
  });
  await Promise.all(workers);
  return out;
}
