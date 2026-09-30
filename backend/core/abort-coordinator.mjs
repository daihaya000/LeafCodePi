import { finalAssistantIdOfCurrentTurn, roomBotIdFromTaskId } from "./abort-control.mjs";

export const TASK_NOT_FOUND_MESSAGE = "タスクが見つかりません";

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
    const abortPromise = deps.abortSession(live);
    const messages = deps.snapshotMessages(live);
    deps.persistManualAbortedAssistantId(id, finalAssistantIdOfCurrentTurn(messages));
    await deps.stopGoalLoop(live);
    await deps.stopSubagentRuns(live, messages);
    await abortPromise;
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
    }
  }
  return deps.toSummary(task);
}
