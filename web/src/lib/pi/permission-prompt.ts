import type { PermissionRequestDto } from "@/lib/types";

export type PermissionPromptEmit = (
  taskId: string,
  payload: { type: string; permissionRequest?: PermissionRequestDto | null; [key: string]: unknown },
) => void;

type Pending = {
  taskId: string;
  request: PermissionRequestDto;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

const PERMISSION_TIMEOUT_MS = 5 * 60_000;

const pendingById = new Map<string, Pending>();
const queueByTask = new Map<string, Pending[]>();

function clearPendingRow(row: Pending): void {
  clearTimeout(row.timer);
  pendingById.delete(row.request.id);
}

function headPending(taskId: string): Pending | null {
  const queue = queueByTask.get(taskId);
  return queue?.[0] ?? null;
}

function finishHead(taskId: string, approved: boolean): Pending | null {
  const queue = queueByTask.get(taskId);
  if (!queue || queue.length === 0) return null;
  const row = queue.shift()!;
  clearPendingRow(row);
  row.resolve(approved);
  if (queue.length === 0) {
    queueByTask.delete(taskId);
    return null;
  }
  const next = queue[0]!;
  armTimer(next);
  return next;
}

function armTimer(row: Pending): void {
  clearTimeout(row.timer);
  row.timer = setTimeout(() => {
    if (headPending(row.taskId)?.request.id !== row.request.id) return;
    finishHead(row.taskId, false);
    pushSnapshotGlobal(row.taskId, headPending(row.taskId)?.request ?? null);
  }, PERMISSION_TIMEOUT_MS);
}

/** Set by createPermissionPromptService — used by armTimer for timeouts. */
let pushSnapshotGlobal: (taskId: string, permissionRequest: PermissionRequestDto | null) => void =
  () => undefined;

export function taskIdForSession(
  sessionId: string,
  liveEntries: Iterable<{ taskId: string; sessionId: string | undefined }>,
): string | null {
  for (const entry of liveEntries) {
    if (entry.sessionId === sessionId) return entry.taskId;
  }
  return null;
}

export function createPermissionPromptService(options: {
  resolveTaskId: (sessionId: string) => string | null;
  emit: PermissionPromptEmit;
  snapshotExtras: (taskId: string) => Record<string, unknown>;
}): {
  handleRequest: (input: Omit<PermissionRequestDto, "id"> & { id: string }) => Promise<boolean>;
  respond: (taskId: string, requestId: string, approved: boolean) => boolean;
  pendingForTask: (taskId: string) => PermissionRequestDto | null;
  dispose: () => void;
} {
  function pushSnapshot(taskId: string, permissionRequest: PermissionRequestDto | null): void {
    options.emit(taskId, {
      type: "snapshot",
      eventType: permissionRequest ? "permission_request" : "permission_resolved",
      permissionRequest,
      ...options.snapshotExtras(taskId),
    });
  }
  pushSnapshotGlobal = pushSnapshot;

  function handleRequest(input: Omit<PermissionRequestDto, "id"> & { id: string }): Promise<boolean> {
    const taskId = options.resolveTaskId(input.sessionId);
    if (!taskId) return Promise.resolve(false);

    const request: PermissionRequestDto = {
      id: input.id,
      sessionId: input.sessionId,
      command: input.command,
      labels: input.labels,
      message: input.message,
    };

    return new Promise((resolve) => {
      const row: Pending = {
        taskId,
        request,
        resolve,
        timer: setTimeout(() => undefined),
      };
      armTimer(row);

      pendingById.set(request.id, row);
      const queue = queueByTask.get(taskId) ?? [];
      queue.push(row);
      queueByTask.set(taskId, queue);

      if (queue.length === 1) {
        pushSnapshot(taskId, request);
      }
    });
  }

  function respond(taskId: string, requestId: string, approved: boolean): boolean {
    const head = headPending(taskId);
    if (!head || head.request.id !== requestId) return false;
    const next = finishHead(taskId, approved);
    pushSnapshot(taskId, next?.request ?? null);
    return true;
  }

  function pendingForTask(taskId: string): PermissionRequestDto | null {
    return headPending(taskId)?.request ?? null;
  }

  function dispose(): void {
    for (const taskId of [...queueByTask.keys()]) {
      const queue = queueByTask.get(taskId) ?? [];
      for (const row of queue) {
        row.resolve(false);
        clearPendingRow(row);
      }
      queueByTask.delete(taskId);
    }
  }

  return { handleRequest, respond, pendingForTask, dispose };
}
