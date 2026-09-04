/**
 * Client-side follow-up queue drain. Abort must not let these auto-send:
 * the server already clearQueue()s on stop, but queuedFollowUps live only in TaskView.
 */

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
