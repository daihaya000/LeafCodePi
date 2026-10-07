import { finalAssistantIdOfCurrentTurn, isHangWatchReplaced, roomBotIdFromTaskId } from "./abort-control.mjs";

export const TASK_NOT_FOUND_MESSAGE = "タスクが見つかりません";
const ROOM_MAILBOX_FLUSH_FAILED_MESSAGE = "タスクの停止は完了しましたが、Roomの未配信メッセージを処理できませんでした。再試行してください。";

function warnCleanupFailure(deps, message, error) {
  try { deps.warn?.(message, error); } catch { /* Logging must not interrupt a requested stop. */ }
}

/** Attempt independent cleanup steps without losing the first failure. */
function createCleanupFailures(deps, kind) {
  let failed = false;
  let failure;
  const capture = (error) => {
    if (!failed) { failed = true; failure = error; }
    else warnCleanupFailure(deps, `[${kind}] additional cleanup failure`, error);
  };
  return {
    capture,
    attempt(action) { try { return action(); } catch (error) { capture(error); } },
    throwIfFailed() { if (failed) throw failure; },
  };
}

/**
 * Ordered user-stop sequence. The session owner injects every side effect, so
 * this module owns only the ordering contract:
 *
 *  1. terminal bookkeeping (disarm watchdog, clear pending prompts)
 *  2. with a live session: drop resumable work, signal the native abort, and
 *     only then project history / run slow cleanup, finally await the abort
 *  3. persist idle + release the lease, then publish the final state
 *  4. flush a Room Bot's mailbox
 */
export async function runUserAbort(id, deps) {
  const failures = createCleanupFailures(deps, "abort");
  failures.attempt(() => deps.disarmHangWatch(id));
  failures.attempt(() => deps.clearPendingAttention(id));
  const live = deps.getLive(id);
  if (live) {
    // Clear resumable work and install the sentinel before signaling the SDK.
    // A store/notification failure must not prevent native abort or later cleanup.
    failures.attempt(() => deps.clearSessionQueue(live));
    failures.attempt(() => deps.cancelPrompt(live));
    failures.attempt(() => deps.cancelPendingSnapshot(live));
    failures.attempt(() => deps.persistManualAbortedAssistantId(id, ""));
    // abort() precedes history projection and cleanup: both can be slow.
    // Observe rejection immediately, even if history/Goal cleanup fails first.
    const abortPromise = Promise.resolve(deps.abortSession(live)).then(
      () => ({ ok: true }), (error) => ({ ok: false, error }),
    );
    let messages = [];
    // Idle reservations need explicit cancellation: native abort emits no agent_end when idle.
    // Treat persistence failures as cleanup errors, never as a reason to skip the native abort.
    if (deps.cancelScheduledResume) {
      try { await deps.cancelScheduledResume(live); } catch (error) { failures.capture(error); }
    }
    try {
      messages = deps.snapshotMessages(live);
      deps.persistManualAbortedAssistantId(id, finalAssistantIdOfCurrentTurn(messages));
    } catch (error) { failures.capture(error); }
    try { await deps.stopGoalLoop(live); } catch (error) { failures.capture(error); }
    // Detached children must still stop if Goal state cannot be persisted.
    try { await deps.stopSubagentRuns(live, messages); } catch (error) { failures.capture(error); }
    const aborted = await abortPromise;
    if (!aborted.ok) {
      // The SDK may still be running: retain working state and the lease.
      failures.throwIfFailed();
      throw aborted.error;
    }
  }
  // A confirmed stop releases its lease even if idle persistence fails.
  const task = failures.attempt(() => deps.setIdle(id));
  failures.attempt(() => deps.releaseLease(id));
  if (!task) {
    failures.throwIfFailed();
    throw Object.assign(new Error(TASK_NOT_FOUND_MESSAGE), { status: 404 });
  }
  // Publish only after idle is saved so every pane drops the stop button.
  if (live) failures.attempt(() => deps.emitAbort(live));
  failures.throwIfFailed();
  // A Room abort clears promptActive before the prompt's finally runs, so flush
  // mailbox rows queued during the Room turn here.
  const roomBotId = roomBotIdFromTaskId(id);
  if (roomBotId) {
    try {
      deps.flushRoomMailbox(roomBotId);
    } catch (error) {
      warnCleanupFailure(deps, "[bot-intercom] flush after Room abort failed", error);
      throw Object.assign(new Error(ROOM_MAILBOX_FLUSH_FAILED_MESSAGE), {
        status: 503,
        code: "ROOM_MAILBOX_FLUSH_FAILED",
        cause: error,
      });
    }
  }
  return deps.toSummary(task);
}

/**
 * Hang-watchdog stop. Unlike a user stop it keeps the persisted watch armed (so
 * the retry can resume), does not tear down the Goal Loop, announces
 * `hang_abort` before the SDK settles, and leaves state alone when a newer
 * prompt re-armed the watch while the abort was in flight.
 */
export async function runHangWatchdogAbort(taskId, deps) {
  // Capture before any await: a newer prompt may replace the watch while the
  // SDK abort settles, and then idle/lease must not tear down that turn.
  const startedAtBeforeAbort = deps.getHangWatchStartedAt(taskId);
  const failures = createCleanupFailures(deps, "hang-abort");
  const live = deps.getLive(taskId);
  failures.attempt(() => deps.clearPendingAttention(taskId));
  if (live) {
    failures.attempt(() => deps.clearSessionQueue(live));
    failures.attempt(() => deps.cancelPrompt(live));
    failures.attempt(() => deps.cancelPendingSnapshot(live));
    // Keep the manual-abort guard active even if agent_end is observed before
    // the final assistant id can be projected. Persistence failure cannot skip abort.
    failures.attempt(() => deps.persistManualAbortedAssistantId(taskId, ""));
    const abortPromise = Promise.resolve(deps.abortSession(live)).then(
      () => ({ ok: true }), (error) => ({ ok: false, error }),
    );
    let messages = [];
    try {
      messages = deps.snapshotMessages(live);
      // Persist before hang_abort so SSE carries the sentinel / assistant id.
      deps.persistManualAbortedAssistantId(taskId, finalAssistantIdOfCurrentTurn(messages));
    } catch (error) { failures.capture(error); }
    // Projection/notification failure must not skip detached child cleanup.
    failures.attempt(() => deps.emitHangAbort(live));
    try { await deps.stopSubagentRuns(live, messages); } catch (error) { failures.capture(error); }
    const aborted = await abortPromise;
    if (!aborted.ok) throw aborted.error;
  }
  if (isHangWatchReplaced(startedAtBeforeAbort, deps.getHangWatch(taskId))) {
    // The replacement turn keeps its working state and lease.
    failures.throwIfFailed();
    return;
  }
  const idleSaved = failures.attempt(() => { deps.setIdle(taskId); return true; });
  failures.attempt(() => deps.releaseLease(taskId));
  if (idleSaved) {
    // Publish only saved idle state; prefer a live session registered meanwhile.
    const idleLive = deps.getLive(taskId) ?? live;
    if (idleLive) failures.attempt(() => deps.emitHangIdle(idleLive));
    // promptChain.finally may have flushed while still streaming (roomBusy no-op);
    // re-flush after the abort settles, but not if idle persistence failed.
    const roomBotId = roomBotIdFromTaskId(taskId);
    if (roomBotId) {
      try {
        deps.flushRoomMailbox(roomBotId);
      } catch (error) {
        warnCleanupFailure(deps, "[bot-intercom] flush after Room hang abort failed", error);
      }
    }
  }
  failures.throwIfFailed();
}
