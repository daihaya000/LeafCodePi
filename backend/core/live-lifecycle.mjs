/**
 * Pure decisions used while disposing a live session. The session owner keeps
 * the map, subscriptions and dispose side effects; callers inject thunks so the
 * evaluation order (and what is never evaluated) stays observable.
 */

/**
 * True when another live session of the same Room Bot is still working, which
 * means the departing session must not bypass the Room-busy mailbox guard.
 * Entries are [taskId, live] pairs.
 */
export function hasOtherBusyRoomLive(departingTaskId, roomBotId, liveEntries) {
  const prefix = `bot:${roomBotId}:room:`;
  for (const [id, other] of liveEntries) {
    if (id === departingTaskId || !id.startsWith(prefix)) continue;
    if (other.promptActive || other.session.isStreaming || other.session.isCompacting) return true;
  }
  return false;
}

/**
 * Whether disposing should first emit extension session_shutdown. Only idle
 * sessions without a session-owned Goal Loop do: Goal Loop pauses on shutdown
 * and must survive routine replacement. Checks are lazy and ordered; any
 * failure means "do not wait for shutdown".
 */
export function shouldShutdownOnDispose({ shutdownEmitted, hasShutdownHandler, isBusyOrGoalLoopActive, isGoalLoopOwned }) {
  if (shutdownEmitted) return false;
  try {
    if (!hasShutdownHandler()) return false;
    if (isBusyOrGoalLoopActive()) return false;
    return !isGoalLoopOwned();
  } catch {
    return false;
  }
}
