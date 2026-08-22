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
const pendingByTask = new Map<string, string>();

function clearPending(id: string): void {
  const row = pendingById.get(id);
  if (!row) return;
  clearTimeout(row.timer);
  pendingById.delete(id);
  if (pendingByTask.get(row.taskId) === id) pendingByTask.delete(row.taskId);
}

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

  function handleRequest(input: Omit<PermissionRequestDto, "id"> & { id: string }): Promise<boolean> {
    const taskId = options.resolveTaskId(input.sessionId);
    if (!taskId) return Promise.resolve(false);

    const existingId = pendingByTask.get(taskId);
    if (existingId) {
      const existing = pendingById.get(existingId);
      existing?.resolve(false);
      clearPending(existingId);
    }

    const request: PermissionRequestDto = {
      id: input.id,
      sessionId: input.sessionId,
      command: input.command,
      labels: input.labels,
      message: input.message,
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        clearPending(request.id);
        pushSnapshot(taskId, null);
        resolve(false);
      }, PERMISSION_TIMEOUT_MS);

      pendingById.set(request.id, { taskId, request, resolve, timer });
      pendingByTask.set(taskId, request.id);
      pushSnapshot(taskId, request);
    });
  }

  function respond(taskId: string, requestId: string, approved: boolean): boolean {
    const row = pendingById.get(requestId);
    if (!row || row.taskId !== taskId) return false;
    clearPending(requestId);
    pushSnapshot(taskId, null);
    row.resolve(approved);
    return true;
  }

  function pendingForTask(taskId: string): PermissionRequestDto | null {
    const id = pendingByTask.get(taskId);
    if (!id) return null;
    return pendingById.get(id)?.request ?? null;
  }

  function dispose(): void {
    for (const id of [...pendingById.keys()]) {
      const row = pendingById.get(id);
      row?.resolve(false);
      clearPending(id);
    }
  }

  return { handleRequest, respond, pendingForTask, dispose };
}
