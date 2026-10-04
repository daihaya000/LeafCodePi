export const RESTART_RESUME_PROMPT: string;
export const RESTART_RESUME_DELAY_MS: number;
export const RESTART_RESUME_STAGGER_MS: number;
export const RESTART_RESUME_MAX_ATTEMPTS: number;
export const RESTART_RESUME_WINDOW_MS: number;
export const RESTART_RESUME_MAX_STALE_MS: number;

/** Structural task contract; the service does not depend on an application store. */
export type RestartResumeTask = {
  id: string;
  kind?: string;
  botId?: string | null;
  supervisorBotId?: string | null;
  updatedAt: string;
  status: string;
  error?: string | null;
};

export type RestartResumeDeps<T extends RestartResumeTask = RestartResumeTask> = {
  getTask: (id: string) => T | undefined;
  promptTask: (id: string, prompt: string) => Promise<unknown>;
  /** Dedicated control path for a Goal Loop-owned orphan; never use promptTask for it. */
  resumeGoalLoop?: (id: string, prompt: string) => Promise<unknown>;
  /** True only for lifecycle-interrupted loops, not operator-paused or blocked loops. */
  canResumeGoalLoop?: (task: T) => boolean;
  isGoalLoopOwned: (task: T) => boolean;
  isRoomDelegated: (taskId: string) => boolean;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => void;
  log?: (message: string, error?: unknown) => void;
};

export function restartResumeSkipReason(snapshot: RestartResumeTask, now: number): string | null;
export function isGoalLoopRestartResumable(loop: {
  status?: string | null;
  pauseReason?: string | null;
} | null | undefined): boolean;

export class RestartResumeService {
  constructor(options: { dataDir: () => string; orphanedTaskError: string });
  resumeOrphanedTask<T extends RestartResumeTask>(snapshot: T, deps: RestartResumeDeps<T>): Promise<boolean>;
  handleOrphanedTasks<T extends RestartResumeTask>(snapshots: T[], deps: RestartResumeDeps<T>): string[];
}

/** Why a candidate cannot be resumed yet, or null when it is resumable. */
export function restartResumeRefusal(input: {
  task: { status: string; error?: string | null } | null | undefined;
  orphanedTaskError: string;
  isRoomDelegated: boolean;
  isGoalLoopOwned: boolean;
  canResumeGoalLoop?: boolean;
}): "changed" | "room-delegated" | "goal-loop-owned" | null;
