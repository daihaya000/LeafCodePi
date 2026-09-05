/**
 * Client-side follow-up queue drain. Abort must not let these auto-send:
 * the server already clearQueue()s on stop, but queuedFollowUps live only in TaskView.
 * TaskView clears the client queue only after abort succeeds (stopRequested blocks
 * drain during the request); SSE abort/hang events also clear via
 * shouldClearQueuedFollowUpOnEvent.
 */

export function shouldQueueFollowUp(input: {
  working: boolean;
  deliveryMode: "queue" | "steer";
  goalLoopEnabled: boolean;
  goalLoopLive?: boolean;
}): boolean {
  return (
    input.working &&
    input.deliveryMode === "queue" &&
    !input.goalLoopEnabled &&
    !input.goalLoopLive
  );
}

export function shouldDrainQueuedFollowUp(input: {
  working: boolean;
  submitting: boolean;
  queuedAutoSend: boolean;
  goalLoopEnabled: boolean;
  goalLoopLive: boolean;
  stopRequested: boolean;
  hasQueuedItem: boolean;
  resumingTurn?: boolean;
  sessionHydrating?: boolean;
  sseReconnecting?: boolean;
}): boolean {
  return (
    input.hasQueuedItem &&
    !input.working &&
    !input.submitting &&
    !input.queuedAutoSend &&
    !input.goalLoopEnabled &&
    !input.goalLoopLive &&
    !input.stopRequested &&
    !input.resumingTurn &&
    !input.sessionHydrating &&
    !input.sseReconnecting
  );
}

export function shouldAutoSendQueuedFollowUp(input: {
  queuedAutoSend: boolean;
  working: boolean;
  submitting: boolean;
  goalLoopEnabled: boolean;
  goalLoopLive: boolean;
  stopRequested: boolean;
  hasContent: boolean;
  resumingTurn?: boolean;
  sessionHydrating?: boolean;
  sseReconnecting?: boolean;
}): boolean {
  return (
    input.queuedAutoSend &&
    input.hasContent &&
    !input.working &&
    !input.submitting &&
    !input.goalLoopEnabled &&
    !input.goalLoopLive &&
    !input.stopRequested &&
    !input.resumingTurn &&
    !input.sessionHydrating &&
    !input.sseReconnecting
  );
}

/** Steer injects into the live turn and does not append a user history row. */
export function shouldShowOptimisticPendingUser(input: {
  working: boolean;
  deliveryMode: "queue" | "steer";
}): boolean {
  return !(input.working && input.deliveryMode === "steer");
}

/** Abort / hang abort/retry must drop the client queue before the idle window can drain it. */
export function shouldClearQueuedFollowUpOnEvent(eventType: string | undefined): boolean {
  return eventType === "abort" || eventType === "hang_abort" || eventType === "hang_retry";
}

/**
 * Hang abort may be dropped while SSE has no listeners (reconnect gap).
 * Ready/bootstrap still carries the abort sentinel — clear the client queue then.
 */
export function shouldClearQueuedFollowUpOnAbortState(
  manualAbortedAssistantId: string | null | undefined,
): boolean {
  return manualAbortedAssistantId != null;
}

/** Steer optimistic rows never landed in history if abort cleared the SDK queue. */
export function shouldClearPendingUserMessageOnEvent(eventType: string | undefined): boolean {
  return eventType === "abort" || eventType === "hang_abort" || eventType === "hang_retry";
}
