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

/** True when a task-touching event has no task row left and must be dropped. */
export function shouldSkipEventForMissingTask(syncTask: boolean, hasTask: boolean): boolean;

/**
 * Runs the agent_start task sync in order: claim the lease, then publish the task
 * as working. Returns false (after marking the task failed) when the lease is held
 * elsewhere, so the caller stops handling this event.
 */
export function runAgentStartTaskSync(
  taskId: string,
  deps: {
    acquireLease: (taskId: string) => boolean;
    setStatus: (taskId: string, status: "working" | "error", error?: string) => unknown;
    busyMessage: string;
  },
): boolean;
