export type SessionEventLike = {
  type: string;
  errorMessage?: string;
  willRetry?: boolean;
  aborted?: boolean;
  reason?: string;
};

export type SessionEventDeps = {
  trackTurnLifecycleFlags: () => void;
  trackProviderLimit: () => void;
  noteWebSocketTransportFailure: () => void;
  /** Automatic compaction failure for this event (live-owned promise present). */
  isHarnessAutoCompactionError: () => boolean;
  shouldSyncTaskFromSessionEvent: (harnessAutoCompactionError: boolean) => boolean;
  getTask: () => unknown;
  shouldSkipEventForMissingTask: (syncTask: boolean, hasTask: boolean) => boolean;
  trackThroughputEvent: () => void;
  /** Claims the task lease and publishes it as working; false stops the event. */
  runAgentStartTaskSync: () => boolean;
  shouldApplySettledStatus: () => boolean;
  applySettledStatus: () => void;
  finishSettledTurn: () => void;
  compactionFailureMessage: (harnessAutoCompactionError: boolean) => string | null | undefined;
  setTaskStatusError: (message: string) => void;
  /** Projects the session identity onto the task (only called when a task exists). */
  patchIdentity: (task: unknown) => void;
  scheduleSnapshot: () => void;
};

/** Which step stopped the event, or null when the whole sequence ran. */
export function runSessionEventEffects(
  event: SessionEventLike,
  deps: SessionEventDeps,
): { stopped: "missing-task" | "lease-busy" | null };
