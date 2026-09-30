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
 * An ensure-live attempt is only valid for the generation it started in. Disposing a
 * session or replacing it bumps the epoch, so a late attempt must not publish its
 * result. A missing entry counts as generation 0.
 */
export function isStaleEnsureEpoch(currentEpoch, epoch) {
  return (currentEpoch ?? 0) !== epoch;
}

/** True when the live registered for the task is exactly the one this attempt attached. */
export function isRegisteredLive(getLive, attached) {
  return getLive() === attached;
}

/**
 * What a caller should do after joining an ensure-live that was already running.
 * A stale generation wins over a registered live: the joined attempt built its
 * session for a generation that has since been invalidated, so a fresh attempt is
 * started instead of adopting whatever is registered now.
 */
export function resolveJoinedEnsureAction({ stale, hasLive }) {
  if (stale === true) return "retry";
  return hasLive === true ? "use-live" : "retry";
}

/**
 * Discard a session that was created but never attached. `createSession` already
 * ran `bindExtensions()` (session_start), so its extensions hold resources; the
 * shutdown event is intentionally NOT emitted here, because the old live session
 * for the same task may still be active and shutting down a duplicate Goal Loop /
 * intercom runtime would pause the loop or clobber the shared process-global
 * intercom identity. Failure paths only; a known residual leak. Disposal errors
 * are swallowed: the caller is already handling another failure.
 */
export function disposeUnattachedSession(session, disposeSession = (value) => value.dispose()) {
  try {
    disposeSession(session);
  } catch { /* best-effort */ }
}

/**
 * What to do with a session that was just created: a stale generation means the
 * work no longer applies (discard the session and retry), a vanished task is a
 * 404, otherwise the session may be attached.
 */
export function resolveCreatedSessionAction({ staleGeneration, hasTask }) {
  if (staleGeneration === true) return "retry";
  if (hasTask !== true) return "not-found";
  return "attach";
}

/**
 * What to do with a session that was just attached: on a stale generation the
 * attached live must not survive — though only when it is still the registered
 * one — and the caller retries either way.
 */
export function resolveAttachedSessionAction({ staleGeneration, isRegistered }) {
  if (staleGeneration !== true) return "keep";
  return isRegistered === true ? "dispose-and-retry" : "retry";
}

/**
 * Publishes a freshly attached live session, in this order: wire the stop hook, stamp
 * the activity clock, insert it into the registry, and finally promote a 1:1 Bot's
 * queued mailbox. The promotion is last so anything it wakes already observes the
 * registered live; a failure in an earlier step propagates and leaves the caller to
 * discard the unattached session.
 */
export function publishAttachedLive(steps) {
  steps.setUnsubscribe();
  steps.markActivity();
  steps.register();
  steps.promoteMailbox();
}

/**
 * Runs an ensure-live attempt and records its promise for the task, clearing the
 * entry once it settles — unless a newer attempt has already replaced it. The
 * returned promise carries the attempt's result, so callers can join it.
 */
export function runTrackedEnsure(taskId, deps) {
  const promise = deps.attempt().finally(() => {
    if (deps.inflight.get(taskId) === promise) deps.inflight.delete(taskId);
  });
  deps.inflight.set(taskId, promise);
  return promise;
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