import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Preserve the existing prompt, timing and disk format during extraction.
export const RESTART_RESUME_PROMPT =
  "WebUIの再起動で前のターンが中断されました。完了済みの操作は繰り返さず、中断した箇所から作業を続けてください。";
export const RESTART_RESUME_DELAY_MS = 5_000;
export const RESTART_RESUME_STAGGER_MS = 1_000;
export const RESTART_RESUME_MAX_ATTEMPTS = 2;
export const RESTART_RESUME_WINDOW_MS = 30 * 60_000;
export const RESTART_RESUME_MAX_STALE_MS = 12 * 60 * 60_000;

export function restartResumeSkipReason(snapshot, now) {
  if ((snapshot.kind ?? "code") !== "code") return "not a Code task";
  if (snapshot.botId || snapshot.supervisorBotId) return "Bot-managed task";
  const updatedAt = Date.parse(snapshot.updatedAt);
  if (Number.isFinite(updatedAt) && now - updatedAt > RESTART_RESUME_MAX_STALE_MS) {
    return "interrupted too long ago";
  }
  return null;
}

/** Only lifecycle pauses may be resumed automatically; preserve user/operator holds. */
export function isGoalLoopRestartResumable(loop) {
  return loop?.status === "running" ||
    (loop?.status === "paused" && (loop.pauseReason ?? "") === "");
}

/**
 * Why a candidate cannot be resumed yet, or null when it is resumable. The order is
 * the refusal precedence: a task the user changed/stopped/deleted, then a
 * Room-delegated task (the Room owns its turn), then one whose session the Goal Loop
 * owns. Callers that only classify (for example a process without a runtime) use this
 * instead of reimplementing the ladder; the resume path uses it too.
 */
export function restartResumeRefusal({
  task,
  orphanedTaskError,
  isRoomDelegated,
  isGoalLoopOwned,
  canResumeGoalLoop,
}) {
  if (!task || task.status !== "error" || task.error !== orphanedTaskError) return "changed";
  if (isRoomDelegated === true) return "room-delegated";
  if (isGoalLoopOwned === true && canResumeGoalLoop !== true) return "goal-loop-owned";
  return null;
}

function defaultLog(message, error) {
  if (error === undefined) console.info(`[restart-resume] ${message}`);
  else console.warn(`[restart-resume] ${message}`, error);
}

/** No store, SDK, environment or timer access until a service method is called. */
export class RestartResumeService {
  constructor({ dataDir, orphanedTaskError }) {
    this.dataDir = dataDir;
    this.orphanedTaskError = orphanedTaskError;
  }

  attemptsPath() {
    return join(this.dataDir(), "restart-resume.json");
  }

  readAttempts() {
    try {
      const parsed = JSON.parse(readFileSync(this.attemptsPath(), "utf8"));
      if (!parsed || typeof parsed !== "object") return {};
      const result = {};
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof value?.count === "number" && typeof value.lastAt === "number") {
          result[id] = { count: value.count, lastAt: value.lastAt };
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  writeAttempts(records) {
    const path = this.attemptsPath();
    mkdirSync(this.dataDir(), { recursive: true });
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(records)}\n`, "utf8");
    renameSync(temporary, path);
  }

  claimAttempt(taskId, now) {
    const records = this.readAttempts();
    for (const [id, record] of Object.entries(records)) {
      if (now - record.lastAt > RESTART_RESUME_WINDOW_MS) delete records[id];
    }
    const count = records[taskId]?.count ?? 0;
    if (count >= RESTART_RESUME_MAX_ATTEMPTS) {
      this.writeAttempts(records);
      return false;
    }
    records[taskId] = { count: count + 1, lastAt: now };
    this.writeAttempts(records);
    return true;
  }

  async resumeOrphanedTask(snapshot, deps) {
    const log = deps.log ?? defaultLog;
    const now = (deps.now ?? Date.now)();
    const task = deps.getTask(snapshot.id);
    // Respect edits/stops/deletion while the delayed resume was waiting.
    const goalLoopOwned = task ? deps.isGoalLoopOwned(task) === true : false;
    const canResumeGoalLoop = goalLoopOwned &&
      typeof deps.resumeGoalLoop === "function" &&
      deps.canResumeGoalLoop?.(task) === true;
    const refusal = restartResumeRefusal({
      task,
      orphanedTaskError: this.orphanedTaskError,
      isRoomDelegated: task ? deps.isRoomDelegated(task.id) === true : false,
      isGoalLoopOwned: goalLoopOwned,
      canResumeGoalLoop,
    });
    if (refusal === "changed") return false;
    if (refusal === "room-delegated") {
      log(`skip ${task.id}: Room-delegated task`);
      return false;
    }
    if (refusal === "goal-loop-owned") {
      log(`skip ${task.id}: Goal Loop owns the session`);
      return false;
    }
    try {
      if (!this.claimAttempt(task.id, now)) {
        log(`skip ${task.id}: reached ${RESTART_RESUME_MAX_ATTEMPTS} restart resumes within the window`);
        return false;
      }
    } catch (error) {
      // Never resend without recording the retry budget first.
      log(`skip ${task.id}: could not record the resume attempt`, error);
      return false;
    }
    try {
      if (goalLoopOwned) {
        await deps.resumeGoalLoop(task.id, RESTART_RESUME_PROMPT);
        log(`resumed Goal Loop ${task.id} after restart`);
      } else {
        await deps.promptTask(task.id, RESTART_RESUME_PROMPT);
        log(`resumed ${task.id} after restart`);
      }
      return true;
    } catch (error) {
      log(`resume failed for ${task.id}`, error);
      return false;
    }
  }

  handleOrphanedTasks(snapshots, deps) {
    const log = deps.log ?? defaultLog;
    const now = (deps.now ?? Date.now)();
    const schedule = deps.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
    });
    const scheduled = [];
    for (const snapshot of snapshots) {
      const reason = restartResumeSkipReason(snapshot, now);
      if (reason) {
        log(`skip ${snapshot.id}: ${reason}`);
        continue;
      }
      const delayMs = RESTART_RESUME_DELAY_MS + scheduled.length * RESTART_RESUME_STAGGER_MS;
      scheduled.push(snapshot.id);
      schedule(() => { void this.resumeOrphanedTask(snapshot, deps); }, delayMs);
    }
    return scheduled;
  }
}
