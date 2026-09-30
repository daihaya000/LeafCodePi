/**
 * Readiness state machine for the runtime owner. A listening socket is not
 * readiness: the host reports ready only after the injected startup sequence
 * (restart recovery, orphan reconciliation, relay, schedulers) has completed,
 * and never after it was stopped or failed. No exception text leaves this
 * module because provider errors can contain credentials.
 *
 * Restarts are bounded and generation-pinned. The generation is an opaque id for
 * the running SDK/extension set (the runtime bundle build id): a restart may not
 * swap it, because a WebUI update must not change the dependencies a running
 * session is using. Changing it requires an explicit operator decision.
 */
export const DEFAULT_RESTART_BUDGET = 3;
export const DEFAULT_RESTART_WINDOW_MS = 5 * 60 * 1000;

export function createRuntimeHost({
  startup,
  warn = console.warn,
  now = () => Date.now(),
  maxRestarts = DEFAULT_RESTART_BUDGET,
  restartWindowMs = DEFAULT_RESTART_WINDOW_MS,
} = {}) {
  if (!startup || typeof startup.start !== "function") throw new Error("startup.start is required");
  if (!Number.isFinite(maxRestarts) || maxRestarts < 0) throw new Error("maxRestarts must be >= 0");
  if (!Number.isFinite(restartWindowMs) || restartWindowMs <= 0) {
    throw new Error("restartWindowMs must be > 0");
  }
  let state = "idle";
  let pending = null;
  /** The generation the current runtime was started with, or null before any start. */
  let generation = null;
  /** Start times inside the current window; pruned on every attempt. */
  let attempts = [];

  const recentAttempts = () => {
    const cutoff = now() - restartWindowMs;
    attempts = attempts.filter((at) => at > cutoff);
    return attempts.length;
  };

  function start() {
    if (state === "stopped") return Promise.reject(new Error("Runtime host is stopped"));
    // Concurrent and repeated calls share one attempt; only a failure allows a retry.
    if (pending) return pending;
    state = "starting";
    recentAttempts();
    attempts.push(now());
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

  /**
   * Restart the runtime, keeping the generation. Refuses when the budget is spent, when the host
   * is stopped, or when the caller asks for a different generation without `allowGenerationChange`.
   * Never throws for those refusals: the caller decides how to report them.
   */
  async function restart({ generation: nextGeneration, allowGenerationChange = false, reason } = {}) {
    if (state === "stopped") return { ok: false, reason: "stopped" };
    if (generation !== null && nextGeneration !== undefined && nextGeneration !== generation && !allowGenerationChange) {
      return { ok: false, reason: "generation-mismatch" };
    }
    if (recentAttempts() >= maxRestarts) return { ok: false, reason: "budget-exhausted" };
    state = "idle";
    pending = null;
    startup.cancelWarmups?.();
    try {
      await start();
    } catch {
      return { ok: false, reason: "startup-failed" };
    }
    if (nextGeneration !== undefined) generation = nextGeneration;
    return { ok: true, generation, restarts: recentAttempts(), reason: reason ?? null };
  }

  return {
    start,
    restart,
    isReady: () => state === "ready",
    /** Coarse state for diagnostics; contains no error detail. */
    status: () => state,
    /** The generation the running runtime was started with, plus the restart budget left. */
    generationInfo: () => ({
      generation,
      restartsInWindow: recentAttempts(),
      maxRestarts,
      windowMs: restartWindowMs,
    }),
    /** Records the generation of the runtime this host owns; set by the runtime loader. */
    setGeneration(next) {
      generation = next ?? null;
    },
    /** Stops optional background work and makes the host permanently not ready. */
    stop() {
      state = "stopped";
      pending = null;
      startup.cancelWarmups?.();
    },
  };
}
