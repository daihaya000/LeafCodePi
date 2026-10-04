export type SchedulableRoutine = { id: string; enabled: boolean; schedule: string; lastRunAt?: string | null };

export function tryAcquireSchedulerLock(options: {
  lockPath: string;
  parentDir: string;
  staleMs: number;
  now?: () => number;
}): string | undefined;

/** Release a lock from `tryAcquireSchedulerLock`, only while it still carries this process's owner token. */
export function releaseSchedulerLock(lockPath: string): void;

export function isRoutineDue(
  routine: SchedulableRoutine,
  options: {
    minute: Date;
    nowMs: number;
    minIntervalMs: number;
    cronMatches: (schedule: string, minute: Date) => boolean;
  },
): boolean;

export function runSchedulerTick<R extends SchedulableRoutine>(
  deps: {
    acquireLock: () => string | undefined;
    releaseLock: (lock: string) => void;
    listBots: () => Array<{ id: string; enabled: boolean }>;
    listRoutines: (botId: string) => R[];
    /** Defaults to the core cron implementation; the Web app injects the same one. */
    cronMatches?: (schedule: string, minute: Date) => boolean;
    minIntervalMs: number;
    runRoutine: (botId: string, routineId: string) => Promise<unknown> | unknown;
  },
  now?: Date,
): Promise<void>;

/** Failure bookkeeping for one routine run; a disabled routine is never re-enabled. */
export function nextRoutineFailureState(
  current: { failureCount?: number; enabled?: boolean } | null | undefined,
  maxFailures: number,
): { failureCount: number; enabled: boolean };

/** Whether the failure count reached the auto-disable limit. */
export function routineAutoDisabled(failureCount: number, maxFailures: number): boolean;

/** Whether the run lost the worker race, so it must not count as a failure. */
export function isTransientRoutineStartError(error: unknown): boolean;
