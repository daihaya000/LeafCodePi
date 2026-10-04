import { finalAssistantIdOfCurrentTurn, isHangWatchReplaced, roomBotIdFromTaskId } from "./abort-control.mjs";

export const TASK_NOT_FOUND_MESSAGE = "タスクが見つかりません";
const ROOM_MAILBOX_FLUSH_FAILED_MESSAGE = "タスクの停止は完了しましたが、Roomの未配信メッセージを処理できませんでした。再試行してください。";

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
  deps.disarmHangWatch(id);
  deps.clearPendingAttention(id);
  const live = deps.getLive(id);
  if (live) {
    // Clear work that could be resumed before asking the SDK to abort; these
    // calls are synchronous and keep the already-requested stop final.
    deps.clearSessionQueue(live);
    deps.cancelPrompt(live);
    deps.cancelPendingSnapshot(live);
    // Install the sentinel first so even a synchronous settled event cannot
    // schedule auto-compaction while the final assistant id is being read.
    deps.persistManualAbortedAssistantId(id, "");
    // abort() precedes history projection and cleanup: both can be slow.
    // Observe rejection immediately, even if history/Goal cleanup fails first.
    const abortPromise = Promise.resolve(deps.abortSession(live)).then(
      () => ({ ok: true }), (error) => ({ ok: false, error }),
    );
    let failure;
    let failed = false;
    const captureFailure = (error) => { if (!failed) { failure = error; failed = true; } };
    let messages = [];
    try {
      messages = deps.snapshotMessages(live);
      deps.persistManualAbortedAssistantId(id, finalAssistantIdOfCurrentTurn(messages));
    } catch (error) { captureFailure(error); }
    try { await deps.stopGoalLoop(live); } catch (error) { captureFailure(error); }
    // Detached children must still stop if Goal state cannot be persisted.
    try { await deps.stopSubagentRuns(live, messages); } catch (error) { captureFailure(error); }
    const aborted = await abortPromise;
    if (failed) {
      // The native abort succeeded, so only history/Goal/child cleanup failed: the
      // task must still leave `working` and drop its lease before the error surfaces.
      // A failed native abort stays working (the SDK may still be running).
      if (aborted.ok) {
        try { deps.setIdle(id); } catch (error) { deps.warn?.("[abort] setIdle after cleanup failure failed", error); }
        try { deps.releaseLease(id); } catch (error) { deps.warn?.("[abort] releaseLease after cleanup failure failed", error); }
        try { deps.emitAbort(live); } catch (error) { deps.warn?.("[abort] emitAbort after cleanup failure failed", error); }
      }
      throw failure;
    }
    if (!aborted.ok) throw aborted.error;
  }
  const task = deps.setIdle(id);
  deps.releaseLease(id);
  if (!task) throw Object.assign(new Error(TASK_NOT_FOUND_MESSAGE), { status: 404 });
  // Publish only after idle is saved so every pane drops the stop button.
  if (live) deps.emitAbort(live);
  // A Room abort clears promptActive before the prompt's finally runs, so flush
  // mailbox rows queued during the Room turn here.
  const roomBotId = roomBotIdFromTaskId(id);
  if (roomBotId) {
    try {
      deps.flushRoomMailbox(roomBotId);
    } catch (error) {
      deps.warn("[bot-intercom] flush after Room abort failed", error);
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
  let cleanupFailed = false;
  let cleanupFailure;
  const live = deps.getLive(taskId);
  deps.clearPendingAttention(taskId);
  if (live) {
    deps.clearSessionQueue(live);
    deps.cancelPrompt(live);
    deps.cancelPendingSnapshot(live);
    // Keep the manual-abort guard active even if agent_end is observed before
    // the final assistant id can be projected.
    deps.persistManualAbortedAssistantId(taskId, "");
    const abortPromise = Promise.resolve(deps.abortSession(live)).then(
      () => ({ ok: true }), (error) => ({ ok: false, error }),
    );
    try {
      const messages = deps.snapshotMessages(live);
      // Persist before hang_abort so SSE carries the sentinel / assistant id.
      deps.persistManualAbortedAssistantId(taskId, finalAssistantIdOfCurrentTurn(messages));
      // Emit before idle so clients clear queued follow-ups before hang_retry.
      deps.emitHangAbort(live);
      await deps.stopSubagentRuns(live, messages);
    } catch (error) {
      // Remember the cleanup failure; idle/lease release below must still run once the
      // native abort settled successfully, then the failure is rethrown.
      cleanupFailed = true;
      cleanupFailure = error;
    }
    const aborted = await abortPromise;
    if (!aborted.ok) throw aborted.error;
  }
  if (isHangWatchReplaced(startedAtBeforeAbort, deps.getHangWatch(taskId))) {
    // The replacement turn keeps its working state and lease.
    if (cleanupFailed) throw cleanupFailure;
    return;
  }
  deps.setIdle(taskId);
  deps.releaseLease(taskId);
  // hang_abort still carried status=working; announce idle even if resume is
  // deferred. A live session registered meanwhile takes precedence.
  const idleLive = deps.getLive(taskId) ?? live;
  if (idleLive) deps.emitHangIdle(idleLive);
  // promptChain.finally may have flushed while still streaming (roomBusy no-op);
  // re-flush after the abort settles.
  const roomBotId = roomBotIdFromTaskId(taskId);
  if (roomBotId) {
    try {
      deps.flushRoomMailbox(roomBotId);
    } catch (error) {
      deps.warn("[bot-intercom] flush after Room hang abort failed", error);
    }
  }
  if (cleanupFailed) throw cleanupFailure;
}
