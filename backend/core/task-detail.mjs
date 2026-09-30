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
