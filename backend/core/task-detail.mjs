/**
 * Which source answers a task-detail read, and what the streaming flag means for it. The
 * assembly of the payload stays with the caller; this owns the branch rules so the Web route
 * and the Backend's internal API answer the same way.
 */

/**
 * - "archived": the task is archived, so only its stored transcript is read (no live session,
 *   no Goal Loop state, and the streaming flag is false).
 * - "offline": the caller asked for an offline read, or another worker owns the task's runtime
 *   lease. Reading another worker's live session here would create a second session for it, so
 *   the append-only transcript is read instead; prompts go through the relay outbox (Bot Code)
 *   or are refused with 409 (ordinary Code).
 * - "live": this worker may use its own live session.
 */
export function resolveTaskDetailSource({ isArchived, isForeignLease, offline }) {
  if (isArchived === true) return "archived";
  if (offline === true || isForeignLease === true) return "offline";
  return "live";
}

/**
 * The streaming flag a detail read reports. An archived task is never streaming; a transcript
 * read reports the stored status (`working` is the only status that means a turn is running);
 * a live read reports what the session actually says, so the caller passes null to keep its own
 * value.
 */
export function detailStreamingFlag(source, taskStatus) {
  if (source === "archived") return false;
  if (source === "offline") return taskStatus === "working";
  return null;
}

/**
 * Whether the Goal Loop state is part of the payload. Only an archived task omits it entirely
 * (null); the other sources include the stored loop state, which may be null when the task has
 * no Goal Loop.
 */
export function detailIncludesGoalLoop(source) {
  return source !== "archived";
}

/**
 * Bounds for an HTTP detail read that may have to create a live session. A live read gets the
 * longer budget; the fallback transcript read is fast and must not hold the request open, and a
 * transcript that also times out is reported as unavailable rather than as a timeout of the
 * original read.
 */
export const TASK_DETAIL_TIMEOUT_MS = 30_000;
export const TASK_DETAIL_OFFLINE_TIMEOUT_MS = 10_000;

/** Whether an error is one of these detail-read timeouts (the flag, not the message). */
export function isDetailTimeoutError(error) {
  return Boolean(
    error && typeof error === "object" && "timeout" in error && error.timeout === true,
  );
}

/**
 * The error a timed-out stage reports: the live stage names the read that timed out, the
 * transcript stage names its own read, and once both timed out the caller gets a 503 that says
 * the detail is unavailable. Each carries the timeout flag so the caller can tell a timeout from
 * a real failure.
 */
export function detailTimeoutError(stage) {
  if (stage === "live") {
    return { message: "タスク詳細の取得がタイムアウトしました", status: 504, timeout: true };
  }
  if (stage === "offline") {
    return { message: "オフラインのタスク詳細取得がタイムアウトしました", status: 504, timeout: true };
  }
  return { message: "タスク詳細を取得できませんでした", status: 503, timeout: true };
}

/**
 * The bookkeeping fields a transcript read reports. The transcript path never runs a turn, so it
 * always reports not compacting and no compaction suggestion; the counters come from the task row,
 * with a missing retry count read as zero.
 */
export function offlineDetailFlags(task) {
  return {
    isCompacting: false,
    compactionSuggested: false,
    hangRetryCount: task?.hangRetryCount || 0,
    revertLeafId: task?.revertLeafId ?? null,
    manualAbortedAssistantId: task?.manualAbortedAssistantId ?? null,
  };
}

/**
 * The same fields for a live read: the session's values win, the stored ones are the fallback,
 * and a live retry count of zero keeps the stored count (a session that has not retried this turn
 * must not hide an earlier count).
 */
export function liveDetailFlags({ task, live }) {
  return {
    manualAbortedAssistantId: live?.manualAbortedAssistantId ?? task?.manualAbortedAssistantId ?? null,
    hangRetryCount: live?.hangRetryCount || task?.hangRetryCount || 0,
    revertLeafId: live?.revertLeafId ?? task?.revertLeafId ?? null,
  };
}

/**
 * A live detail read that failed for any reason other than a coded refusal is reported as a
 * 503: the caller must not mistake an internal failure for a missing task.
 */
export function liveDetailErrorStatus(error) {
  if (error && typeof error === "object" && "status" in error) return null;
  return 503;
}
