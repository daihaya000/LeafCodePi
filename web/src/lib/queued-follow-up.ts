/**
 * Client-side follow-up queue drain. Abort must not let these auto-send:
 * the server already clearQueue()s on stop, but queuedFollowUps live only in TaskView.
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
}): boolean {
  return (
    input.hasQueuedItem &&
    !input.working &&
    !input.submitting &&
    !input.queuedAutoSend &&
    !input.goalLoopEnabled &&
    !input.goalLoopLive &&
    !input.stopRequested
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
}): boolean {
  return (
    input.queuedAutoSend &&
    input.hasContent &&
    !input.working &&
    !input.submitting &&
    !input.goalLoopEnabled &&
    !input.goalLoopLive &&
    !input.stopRequested
  );
}

/** Hang abort/retry must drop the client queue before the idle window can drain it. */
export function shouldClearQueuedFollowUpOnEvent(eventType: string | undefined): boolean {
  return eventType === "hang_abort" || eventType === "hang_retry";
}

/** Steer optimistic rows never landed in history if abort cleared the SDK queue. */
export function shouldClearPendingUserMessageOnEvent(eventType: string | undefined): boolean {
  return eventType === "abort" || eventType === "hang_abort" || eventType === "hang_retry";
}
