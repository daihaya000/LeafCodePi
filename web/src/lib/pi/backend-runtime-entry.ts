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
  // Rewinding a transcript rewrites the session and clears the owner's pending attention.
  revertTask,
  unrevertTask,
} from "@/lib/pi/harness";
// Stopping a Bot Code request also updates the outbox, which the owning process must do.
export { cancelBotCodeRequests, isRoomDelegatedCodeTask, stopBotCodeRequest } from "@/lib/pi/bot-code-relay";
// Clearing a Code session link writes the store and the Bot record: the owner does both.
export { botTaskId, getBot, patchBot } from "@/lib/bots";
// The routine scheduler runs its routines by prompting a session, so only the runtime owner may
// run it; the tick takes a cross-process lock, so two schedulers cannot double-run a routine.
export { ensureRoutineScheduler, runRoutine } from "@/lib/routines";
// Room recovery settles abandoned turns and delivers ready handoffs, which needs the runtime.
export { reconcileRoomRuntime } from "@/lib/room-runtime";
// Rewinding a Room conversation stops its turns and drops the owner's attention and Code jobs.
export { revertRoomConversation } from "@/lib/room-revert";
export { getTask, patchTask } from "@/lib/store";
export { isGoalLoopSessionOwned, readGoalLoopState } from "@/lib/pi/goal-loop-state";
export { startGoalLoopWithSelection } from "@/lib/pi/goal-loop-start";
export { startBotGoalLoop } from "@/lib/pi/bot-goal-loop-start";
