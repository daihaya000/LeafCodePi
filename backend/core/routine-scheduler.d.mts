export type SchedulableRoutine = { id: string; enabled: boolean; schedule: string; lastRunAt?: string | null };

export function tryAcquireSchedulerLock(options: {
  lockPath: string;
  parentDir: string;
  staleMs: number;
  now?: () => number;
}): string | undefined;

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
    cronMatches: (schedule: string, minute: Date) => boolean;
    minIntervalMs: number;
    runRoutine: (botId: string, routineId: string) => Promise<unknown> | unknown;
  },
  now?: Date,
): Promise<void>;
