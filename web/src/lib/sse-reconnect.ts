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

/**
 * Fire `onWake` when the network comes back or the page becomes visible again. A stream in
 * backoff (up to 15s) should reconnect right away then instead of leaving the transcript frozen
 * after Wi-Fi returns or a laptop wakes; callers only act while a reconnect is pending.
 */
export function subscribeSseReconnectWake(onWake: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onVisibility = () => {
    if (document.visibilityState === "visible") onWake();
  };
  window.addEventListener("online", onWake);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("online", onWake);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
