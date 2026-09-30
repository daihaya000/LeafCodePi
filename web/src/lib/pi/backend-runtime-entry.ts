/**
 * Runtime entry for the Backend process. It re-exports the harness surface the Backend needs to run
 * sessions itself; the bundle is produced by `node scripts/build-backend-runtime.mjs` and imported
 * from `backend/runtime/runtime.bundle.mjs`.
 *
 * Keep this list to the operations the Backend actually performs: session creation and prompting,
 * task detail reads, abort handling and the attention services. Anything the Web UI needs only for
 * rendering stays out, so the bundle does not grow a UI dependency.
 */
export {
  promptTask,
  getTaskDetail,
  abortTask,
  // Abort must reproduce both the Goal Loop (cold) path and the Bot-owned outbox path.
  abortTaskIncludingColdGoalLoop,
  stopBotCodeTask,
  listPendingAttention,
  pendingPermissionForTask,
  pendingQuestionForTask,
  respondToPermissionPrompt,
  respondToQuestionPrompt,
  clearPendingAttentionForTask,
  completeBotCodeRequest,
  createBotCodeTask,
  continueBotCodeTask,
  goalLoopCommand,
  goalLoopState,
  startBotCodeRelay,
  applyCodePermissionSettingsToLiveTasks,
} from "@/lib/pi/harness";
// Stopping a Bot Code request also updates the outbox, which the owning process must do.
export { isRoomDelegatedCodeTask, stopBotCodeRequest } from "@/lib/pi/bot-code-relay";
// Clearing a Code session link writes the store and the Bot record: the owner does both.
export { getBot, patchBot } from "@/lib/bots";
export { getTask, patchTask } from "@/lib/store";
export { isGoalLoopSessionOwned, readGoalLoopState } from "@/lib/pi/goal-loop-state";
export { startGoalLoopWithSelection } from "@/lib/pi/goal-loop-start";
