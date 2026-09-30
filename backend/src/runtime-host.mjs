/**
 * Readiness state machine for the runtime owner. A listening socket is not
 * readiness: the host reports ready only after the injected startup sequence
 * (restart recovery, orphan reconciliation, relay, schedulers) has completed,
 * and never after it was stopped or failed. No exception text leaves this
 * module because provider errors can contain credentials.
 */
export function createRuntimeHost({ startup, warn = console.warn }) {
  if (!startup || typeof startup.start !== "function") throw new Error("startup.start is required");
  let state = "idle";
  let pending = null;

  function start() {
    if (state === "stopped") return Promise.reject(new Error("Runtime host is stopped"));
    // Concurrent and repeated calls share one attempt; only a failure allows a retry.
    if (pending) return pending;
    state = "starting";
    const attempt = Promise.resolve()
      .then(() => startup.start())
      .then(
        () => {
          // A stop that raced the startup wins: a stopped host is never ready.
          if (pending === attempt && state === "starting") state = "ready";
        },
        (error) => {
          if (pending === attempt) {
            pending = null;
            if (state === "starting") state = "failed";
          }
          warn("[backend] runtime startup failed", error instanceof Error ? error.name : "Error");
          throw error;
        },
      );
    pending = attempt;
    return attempt;
  }

  return {
    start,
    isReady: () => state === "ready",
    /** Coarse state for diagnostics; contains no error detail. */
    status: () => state,
    /** Stops optional background work and makes the host permanently not ready. */
    stop() {
      state = "stopped";
      pending = null;
      startup.cancelWarmups?.();
    },
  };
}
