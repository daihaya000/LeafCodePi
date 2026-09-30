export type SessionSyncEvent = {
  type: string;
  willRetry?: boolean;
  aborted?: boolean;
  errorMessage?: string;
  reason?: string;
};

/** True when an automatic compaction failure must be recorded as a task error. */
export function isHarnessAutoCompactionError(
  event: SessionSyncEvent,
  hasAutoCompactionPromise: boolean,
): boolean;

/** True when this event should trigger a task metadata re-read and patch. */
export function shouldSyncTaskFromSessionEvent(
  event: SessionSyncEvent,
  harnessAutoCompactionError: boolean,
): boolean;

/** True when this event settles the turn and the task status should follow. */
export function shouldApplySettledStatus(event: SessionSyncEvent, pendingTransportRecovery: boolean): boolean;

/** The message to record as a task error, or null when this event carries none. */
export function compactionFailureMessage(
  event: SessionSyncEvent,
  harnessAutoCompactionError: boolean,
): string | null;
