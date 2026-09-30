import { mkdirSync, rmSync, statSync } from "node:fs";
import { cronMatches as defaultCronMatches } from "./routine-schedule.mjs";

/**
 * Cross-worker scheduler lock: an atomically created directory. A holder that
 * died leaves it behind, so one older than `staleMs` is reclaimed (the reclaim
 * itself can lose a race, which just means another worker owns it). Returns the
 * lock path, or undefined when another worker owns it.
 */
export function tryAcquireSchedulerLock({ lockPath, parentDir, staleMs, now = () => Date.now() }) {
  mkdirSync(parentDir, { recursive: true });
  try {
    mkdirSync(lockPath);
    return lockPath;
  } catch {
    try {
      if (now() - statSync(lockPath).mtimeMs > staleMs) {
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath);
        return lockPath;
      }
    } catch { /* another worker owns or replaced the lock */ }
    return undefined;
  }
}

/**
 * True when an enabled routine should start for this minute: its cron matches and
 * the last run is not within the minimum interval. A missing or unparsable
 * lastRunAt never blocks a run.
 */
export function isRoutineDue(routine, { minute, nowMs, minIntervalMs, cronMatches }) {
  if (!routine.enabled) return false;
  try {
    if (!cronMatches(routine.schedule, minute)) return false;
  } catch {
    // A schedule that cannot be parsed (hand-edited file) is never due: one bad
    // row must not abort the whole tick and strand every other routine.
    return false;
  }
  const lastRunAt = routine.lastRunAt ? new Date(routine.lastRunAt).getTime() : Number.NaN;
  return !(Number.isFinite(lastRunAt) && nowMs - lastRunAt < minIntervalMs);
}

/**
 * One scheduler tick. Holds the cross-worker lock only while deciding what is
 * due; started runs are fire-and-forget (failures are swallowed here, the run
 * records its own outcome) and are not awaited, so the lock is released before
 * any routine finishes. Disabled bots are skipped entirely. Routines are
 * started in the same synchronous pass, in bot/routine order.
 */
export async function runSchedulerTick(deps, now = new Date()) {
  const lock = deps.acquireLock();
  if (!lock) return;
  // The core cron implementation is the default; callers may still inject one
  // (the Web app supplies the same module through its compatibility entrypoint).
  const matches = deps.cronMatches ?? defaultCronMatches;
  try {
    const minute = new Date(now);
    minute.setSeconds(0, 0);
    const nowMs = now.getTime();
    for (const bot of deps.listBots()) {
      if (!bot.enabled) continue;
      for (const routine of deps.listRoutines(bot.id)) {
        if (!isRoutineDue(routine, { minute, nowMs, minIntervalMs: deps.minIntervalMs, cronMatches: matches })) continue;
        // Start synchronously (the run claims its slot before its first await),
        // then detach. A synchronous throw must not abort the remaining routines.
        try {
          void Promise.resolve(deps.runRoutine(bot.id, routine.id)).catch(() => undefined);
        } catch { /* runs record their own failures */ }
      }
    }
  } finally {
    deps.releaseLock(lock);
  }
}

/**
 * A failed routine run counts toward the auto-disable ladder: the failure count grows
 * and the routine stays enabled only while it is below the limit (an already-disabled
 * routine is never re-enabled by a failure).
 */
export function nextRoutineFailureState(current, maxFailures) {
  const failureCount = (current?.failureCount ?? 0) + 1;
  return {
    failureCount,
    enabled: current?.enabled === true && failureCount < maxFailures,
  };
}

/** The failure count reached the limit, so the run's error carries the auto-disable note. */
export function routineAutoDisabled(failureCount, maxFailures) {
  return failureCount >= maxFailures;
}

/**
 * A run that lost the worker race is transient: it must not count as a routine failure,
 * because another worker is already running the same routine.
 */
export function isTransientRoutineStartError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("別のワーカーで実行中");
}
