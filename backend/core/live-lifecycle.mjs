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

/** Bot id for a 1:1 Bot task id (`bot:<botId>`), otherwise null. Room ids never match. */
export function oneToOneBotIdFromTaskId(taskId) {
  return /^bot:([^:]+)$/.exec(taskId)?.[1] ?? null;
}

/**
 * Which account a newly attached session runs under, and whether a runtime
 * reference must be acquired first. An explicit session account (including an
 * explicit null) wins over the stored task account, which is intentionally
 * left unchanged in that case. The reference already held by the live being
 * replaced is kept rather than acquired twice.
 */
export function resolveAttachAccount({ sessionAccountId, taskAccountId, existingAccountId }) {
  const accountId = sessionAccountId !== undefined ? (sessionAccountId ?? null) : (taskAccountId ?? null);
  const keepsExistingRef = Boolean(accountId && existingAccountId === accountId);
  return { accountId, acquire: Boolean(accountId) && !keepsExistingRef };
}