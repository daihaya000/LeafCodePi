/**
 * Initial state for a live session being attached. Each helper restores what the
 * replaced live (or the persisted task, or the transcript) already knew, and falls
 * back to a fresh value so callers can spread the result straight into the new live.
 *
 * The versioned throughput/timing maps are injected: they are Web-side classes, and
 * only their construction depends on a transcript scan.
 */
export function restoredPromptState(existing) {
  return {
    accountByMessageId: existing?.accountByMessageId ?? new Map(),
    agentByMessageId: existing?.agentByMessageId ?? new Map(),
    // Keep a queued prompt chain when an idle session is replaced for the next
    // turn. The current run owns this promise, so follow-ups submitted during
    // session creation still wait for it.
    promptChain: existing?.promptChain ?? Promise.resolve(),
    promptActive: existing?.promptActive ?? false,
    pendingSettings: existing?.pendingSettings,
    promptEpoch: existing?.promptEpoch ?? 0,
    toolPartialOutputByCallId: existing?.toolPartialOutputByCallId ?? new Map(),
  };
}

export function restoredTaskMetadata(existing, task) {
  return {
    revertLeafId: existing?.revertLeafId ?? task?.revertLeafId ?? null,
    manualAbortedAssistantId:
      existing?.manualAbortedAssistantId ?? task?.manualAbortedAssistantId ?? null,
    hangRetryCount: existing?.hangRetryCount ?? task?.hangRetryCount ?? 0,
    pendingProviderFallback: existing?.pendingProviderFallback ?? null,
    preserveTaskModel: existing?.preserveTaskModel === true,
  };
}

export function restoredThroughputState(existing, loaded, loadedToolTiming, deps) {
  return {
    throughputByStartedAt:
      existing?.throughputByStartedAt ?? deps.createThroughputMap(loaded?.timings),
    persistedThroughputKeys:
      existing?.persistedThroughputKeys ?? loaded?.persistedKeys ?? new Set(),
    toolStartedAt:
      existing?.toolStartedAt ?? deps.createTimingMap(loadedToolTiming?.startedAt),
    toolEndedAt:
      existing?.toolEndedAt ?? deps.createTimingMap(loadedToolTiming?.endedAt),
  };
}
