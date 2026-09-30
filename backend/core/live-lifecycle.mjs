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

/**
 * Disposing a live is deferred when one is already shutting down for the same task:
 * the caller joins the in-flight promise instead of stacking a second extension
 * shutdown and session dispose on the same session. The entry is cleared by the
 * operation that still owns it (a newer one replaces the entry and clears itself).
 */
export function runCoalescedLiveShutdown(taskId, deps) {
  const pending = deps.runShutdown().finally(() => {
    deps.disposeSession();
    if (deps.inflight.get(taskId) === pending) deps.inflight.delete(taskId);
  });
  deps.inflight.set(taskId, pending);
  return pending;
}

/**
 * Detach the live being replaced by a new session, in a fixed order: stop
 * receiving events, release the account runtime reference it held (only when the
 * replacement runs on a different account), dispose the replaced session (unless
 * it IS the new session), then cancel any pending snapshot timer. Does nothing
 * when there is no previous live.
 */
export function detachReplacedLive(existing, session, attachedAccountId, deps) {
  if (!existing) return;
  existing.unsubscribe();
  if (existing.accountId && existing.accountId !== attachedAccountId) {
    deps.releaseAccount(existing.accountId);
  }
  const replacedSession = existing.session;
  if (replacedSession && replacedSession !== session) {
    deps.disposeSession(replacedSession);
  }
  if (existing.snapshotTimer) deps.clearSnapshotTimer(existing.snapshotTimer);
}

/** Bot id for a 1:1 Bot task id (`bot:<botId>`), otherwise null. Room ids never match. */
export function oneToOneBotIdFromTaskId(taskId) {
  return /^bot:([^:]+)$/.exec(taskId)?.[1] ?? null;
}

/**
 * Offline→resident promotion: attaching a 1:1 Bot live hands its queued mailbox
 * rows to the delivery path. Room attaches deliberately do NOT flush here (a Room
 * may still be idle before its prompt, and waking would steal the row into the 1:1
 * chat); Room settle/abort flushes instead. A failing flush is warned, never
 * raised: the attach itself already succeeded.
 *
 * Returns true when a 1:1 Bot mailbox was handed over.
 */
export function promoteMailboxOnAttach(taskId, deps) {
  const botId = oneToOneBotIdFromTaskId(taskId);
  if (!botId) return false;
  try {
    deps.flushMailbox(botId);
  } catch (error) {
    deps.warn("[bot-intercom] flush after Bot live attach failed", error);
  }
  return true;
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