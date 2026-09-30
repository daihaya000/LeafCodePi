/** Prompt/session state a live carries between replacements. */
export type PromptStateKeys =
  | "accountByMessageId"
  | "agentByMessageId"
  | "promptChain"
  | "promptActive"
  | "pendingSettings"
  | "promptEpoch"
  | "toolPartialOutputByCallId";

/** Task-derived fields of a live. */
export type TaskMetadataKeys =
  | "revertLeafId"
  | "manualAbortedAssistantId"
  | "hangRetryCount"
  | "pendingProviderFallback"
  | "preserveTaskModel";

/** Transcript-derived timing fields of a live. */
export type ThroughputStateKeys =
  | "throughputByStartedAt"
  | "persistedThroughputKeys"
  | "toolStartedAt"
  | "toolEndedAt";

/**
 * The picked fields keep the caller's own types (and optionality), so the result
 * can be spread straight into the new live.
 */
export function restoredPromptState<Live extends object>(
  existing: Live | undefined,
): Pick<Live, PromptStateKeys & keyof Live>;

export function restoredTaskMetadata<Live extends object>(
  existing: Live | undefined,
  task: Partial<Record<"revertLeafId" | "manualAbortedAssistantId" | "hangRetryCount", unknown>> | undefined,
): Pick<Live, TaskMetadataKeys & keyof Live>;

export function restoredThroughputState<Live extends object>(
  existing: Live | undefined,
  loaded: { timings?: unknown; persistedKeys?: Set<unknown> } | null,
  loadedToolTiming: { startedAt?: unknown; endedAt?: unknown } | null,
  deps: {
    /** `initial` is the transcript scan payload, typed by the caller's map class. */
    createThroughputMap: (initial: any) => Live["throughputByStartedAt" & keyof Live];
    createTimingMap: (initial: any) => Live["toolStartedAt" & keyof Live];
  },
): Pick<Live, ThroughputStateKeys & keyof Live>;
