export const TASK_LEASE_STALE_MS: number;
export const HEARTBEAT_MS: number;
export const RECLAIM_LOCK_STALE_MS: number;
export const ORPHANED_WORKING_TASK_ERROR: string;

export type TaskLeaseTask = { id: string; status: string; error?: string | null };
export type OrphanedTaskListener<T extends TaskLeaseTask = TaskLeaseTask> = (tasks: T[]) => void;
export type TaskLeaseLostListener = (taskIds: string[]) => void;
export type HeartbeatHandle = { unref?: () => unknown };
export type TaskLeaseState<T extends TaskLeaseTask = TaskLeaseTask> = {
  token: string;
  ownedTasks: Set<string>;
  heartbeatTimer: HeartbeatHandle | null;
  orphanListener?: OrphanedTaskListener<T> | null;
  pendingOrphans?: T[];
  leaseLostListener?: TaskLeaseLostListener | null;
  /** Unbounded, deduplicated task ids awaiting local abort after lease loss. */
  pendingLeaseLosses?: string[];
  pendingLeaseLossIds?: Set<string>;
};

export function createTaskLeaseState<T extends TaskLeaseTask = TaskLeaseTask>(): TaskLeaseState<T>;

export class TaskLeaseService<T extends TaskLeaseTask = TaskLeaseTask> {
  constructor(options: {
    dataDir: () => string;
    listTasks: () => T[];
    patchTask: (id: string, patch: { status: "error"; error: string }) => T | undefined;
    state?: TaskLeaseState<T>;
    pid?: number;
    now?: () => number;
    isProcessAlive?: (pid: number) => boolean;
    setHeartbeat?: (callback: () => void, delayMs: number) => HeartbeatHandle;
    clearHeartbeat?: (handle: HeartbeatHandle) => void;
    warn?: (message: string, error: unknown) => void;
    /** Heartbeat file replacement; injectable so tests can simulate write failures. */
    renameFile?: (from: string, to: string) => void;
    /** Atomic exclusive create of the lease file (hard link); injectable for tests. */
    linkFile?: (existing: string, target: string) => void;
  });
  taskRuntimeLeasePath(taskId: string): string;
  acquireTaskLease(taskId: string): boolean;
  releaseTaskLease(taskId: string): void;
  ownsTaskLease(taskId: string): boolean;
  hasActiveTaskLease(taskId: string): boolean;
  setOrphanedTaskListener(listener: OrphanedTaskListener<T> | null): void;
  setLeaseLostListener(listener: TaskLeaseLostListener | null): void;
  reconcileOrphanedWorkingTasks(): string[];
  stopHeartbeat(): void;
}
