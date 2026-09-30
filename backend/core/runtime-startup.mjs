export const SESSION_LABEL_BACKFILL_DELAY_MS = 60_000;

function scheduleBackground(callback, delayMs) {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Startup ordering, not SDK/backend readiness; the caller supplies all services. */
export class RuntimeStartup {
  #startPromise = null;
  #cancelLabels = null;
  #warmupsCancelled = false;

  constructor({ loadServices, warn = console.warn, schedule = scheduleBackground }) {
    this.loadServices = loadServices;
    this.warn = warn;
    this.schedule = schedule;
  }

  start() {
    if (!this.#startPromise) {
      const pending = Promise.resolve()
        .then(() => this.loadServices())
        .then((services) => this.#initialize(services))
        .catch((error) => {
          if (this.#startPromise === pending) this.#startPromise = null;
          throw error;
        });
      this.#startPromise = pending;
    }
    return this.#startPromise;
  }

  async #initialize(services) {
    try {
      await services.registerRestartResume();
    } catch (error) {
      this.warn("[restart-resume] unavailable", error);
    }
    // Register before reconciliation, and reconcile before publishing relay work.
    await services.reconcileOrphanedWorkingTasks();
    await services.startBotCodeRelay();
    await services.ensureRoutineScheduler();
    await services.reconcileRoomRuntime();
    this.#warm(services.warmTaskSummaries);
    this.#warm(services.warmModels);
    if (services.backfillMissingTaskLabels && !this.#warmupsCancelled) {
      this.#cancelLabels = this.schedule(() => {
        this.#cancelLabels = null;
        this.#warm(services.backfillMissingTaskLabels);
      }, SESSION_LABEL_BACKFILL_DELAY_MS);
    }
  }

  #warm(callback) {
    if (!callback) return;
    // Both synchronous throws and rejected promises are optional warmup failures.
    void Promise.resolve().then(() => {
      if (!this.#warmupsCancelled) return callback();
    }).catch(() => undefined);
  }

  /** Prevents pending warmups; never stops in-flight work, SDK sessions or services. */
  cancelWarmups() {
    this.#warmupsCancelled = true;
    this.#cancelLabels?.();
    this.#cancelLabels = null;
  }
}
