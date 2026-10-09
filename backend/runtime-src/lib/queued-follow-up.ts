/**
 * Client-side follow-up queue drain. Abort must not let these auto-send:
 * the server already clearQueue()s on stop, but queuedFollowUps live only in TaskView.
 * TaskView clears the client queue only after abort succeeds (stopRequested blocks
 * drain during the request); SSE abort/hang events also clear via
 * shouldClearQueuedFollowUpOnEvent.
 */

export function shouldRestoreQueuedFollowUpOnFailure(sentEpoch: number, currentEpoch: number): boolean {
  return sentEpoch === currentEpoch;
}

export function shouldQueueFollowUp(input: {
  working: boolean;
  goalLoopEnabled: boolean;
}): boolean {
  return input.working && !input.goalLoopEnabled;
}

export function shouldDrainQueuedFollowUp(input: {
  working: boolean;
  submitting: boolean;
  queuedAutoSend: boolean;
  goalLoopEnabled: boolean;
  goalLoopLive: boolean;
  stopRequested: boolean;
  hasQueuedItem: boolean;
  queueFailed?: boolean;
  resumingTurn?: boolean;
  sessionHydrating?: boolean;
  sseReconnecting?: boolean;
  /** Match submit() guards — do not pop work that submit() would silently reject. */
  compacting?: boolean;
  submitInFlight?: boolean;
  revertBusy?: boolean;
  revertConfirmOpen?: boolean;
}): boolean {
  return (
    input.hasQueuedItem &&
    !input.queueFailed &&
    !input.working &&
    !input.submitting &&
    !input.queuedAutoSend &&
    !input.goalLoopEnabled &&
    !input.goalLoopLive &&
    !input.stopRequested &&
    !input.resumingTurn &&
    !input.sessionHydrating &&
    !input.sseReconnecting &&
    !input.compacting &&
    !input.submitInFlight &&
    !input.revertBusy &&
    !input.revertConfirmOpen
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
  /** Match submit() guards — do not invoke it when it would silently reject the item. */
  compacting?: boolean;
  submitInFlight?: boolean;
  revertBusy?: boolean;
  revertConfirmOpen?: boolean;
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
    !input.sseReconnecting &&
    !input.compacting &&
    !input.submitInFlight &&
    !input.revertBusy &&
    !input.revertConfirmOpen
  );
}

/** Abort / hang / archive / conversation reset must drop the client queue before idle can drain it. */
export function shouldClearQueuedFollowUpOnEvent(eventType: string | undefined): boolean {
  return (
    eventType === "abort" ||
    eventType === "hang_abort" ||
    eventType === "hang_idle" ||
    eventType === "hang_retry" ||
    eventType === "archived" ||
    eventType === "conversation_reset" ||
    eventType === "goal_command_stale"
  );
}

/**
 * Hang abort may be dropped while SSE has no listeners (reconnect gap).
 * Ready/bootstrap still carries the abort sentinel — clear the client queue then.
 */
export function shouldClearQueuedFollowUpOnAbortState(
  manualAbortedAssistantId: string | null | undefined,
  working = false,
): boolean {
  // A previous abort sentinel remains until the next turn starts. Do not clear
  // follow-ups queued during that new run's accepted-to-streaming gap.
  return manualAbortedAssistantId != null && !working;
}
