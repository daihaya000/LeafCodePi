/** Backoff for TaskView EventSource reconnects. Attempt 1 = 1s, capped at 15s. */
export function sseReconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(attempt - 1, 0), 15_000);
}

/**
 * Drop a pending reconnect timer before arming another. Consecutive stream
 * errors otherwise stack timeouts and open multiple EventSources.
 */
export function cancelPendingSseReconnect(
  retryTimer: ReturnType<typeof setTimeout> | null,
  clearTimer: (id: ReturnType<typeof setTimeout>) => void = clearTimeout,
): null {
  if (retryTimer) clearTimer(retryTimer);
  return null;
}

export function closeSseSource(source: { close: () => void } | null): null {
  source?.close();
  return null;
}
