/**
 * Per-event decisions for a live session's subscription. Each one answers a
 * single question about a session event so the handler only sequences effects.
 */
function isCompactionFailure(event) {
  return event?.type === "compaction_end" && !event.aborted && Boolean(event.errorMessage);
}

/**
 * An automatic compaction failure is one the harness started itself; the user is
 * not watching it, so it is recorded even though `reason` says "manual".
 */
export function isHarnessAutoCompactionError(event, hasAutoCompactionPromise) {
  return isCompactionFailure(event) && hasAutoCompactionPromise === true;
}

/** Sync metadata at actual run boundaries, not intermediate low-level agent_end. */
export function shouldSyncTaskFromSessionEvent(event, harnessAutoCompactionError) {
  return (
    event.type === "agent_start" ||
    event.type === "agent_settled" ||
    (isCompactionFailure(event) && (event.reason !== "manual" || harnessAutoCompactionError === true))
  );
}

/**
 * Only agent_settled closes the run. Even a non-retrying agent_end precedes
 * post-run extension writes, compaction and before-settle continuations. Releasing
 * the lease there makes those writes look like lost ownership and disposes the
 * session before Goal Loop can send its verification turn. While transport
 * recovery is pending the outcome belongs to the replacement attempt.
 */
export function shouldApplySettledStatus(event, pendingTransportRecovery) {
  if (pendingTransportRecovery === true) return false;
  return event.type === "agent_settled";
}

/** The message to record as a task error, or null when this event carries none. */
export function compactionFailureMessage(event, harnessAutoCompactionError) {
  if (!isCompactionFailure(event)) return null;
  if (event.reason === "manual" && harnessAutoCompactionError !== true) return null;
  return event.errorMessage;
}

/**
 * A task-touching event with no task row left (hard-deleted mid-turn) is dropped:
 * there is nothing left to record, and the streams keep flowing until the session
 * settles by itself.
 */
export function shouldSkipEventForMissingTask(syncTask, hasTask) {
  return syncTask === true && hasTask !== true;
}

/**
 * An agent turn starting re-claims the task's runtime lease before it is published
 * as working. A lease held elsewhere is a conflict, not a failure of the turn: the
 * task is marked failed and the caller must stop processing the event. Returns
 * true when the caller may continue.
 */
export function runAgentStartTaskSync(taskId, deps) {
  if (!deps.acquireLease(taskId)) {
    deps.setStatus(taskId, "error", deps.busyMessage);
    return false;
  }
  deps.setStatus(taskId, "working");
  return true;
}
