import { AppStore } from "../core/app-store.mjs";
import { dataDir as defaultDataDir, noProjectSessionDir, samePath, storePath } from "../core/app-paths.mjs";
import { createTaskLeaseState, TaskLeaseService } from "../core/task-runtime-lease.mjs";
import { RuntimeStartup } from "../core/runtime-startup.mjs";

/** Must match NO_PROJECT_NAME in shared/types.ts (the Backend cannot import TypeScript). */
const NO_PROJECT_NAME = "プロジェクトなし";

/**
 * Startup steps that need a Pi runtime or a Web-owned service and therefore cannot run
 * in the Backend process yet. They are reported instead of silently skipped, so a
 * caller can tell a complete startup from a prefix. Readiness must stay false while
 * this list is non-empty.
 */
export const BACKEND_UNAVAILABLE_STARTUP_STEPS = Object.freeze([
  "startBotCodeRelay",
  "ensureRoutineScheduler",
  "reconcileRoomRuntime",
]);

/**
 * The part of the startup sequence the Backend process can already run on its own:
 * it owns the application store and the task lease, so stale leases are reclaimed and
 * working tasks without a live lease are reconciled to error before anything else
 * touches them. The services that still need the runtime are recorded in
 * `unavailable()`, and the host's readiness stays the caller's decision.
 *
 * Nothing is scheduled here: `start()` runs the sequence once, and a failure in a
 * required step rejects (the host decides whether to retry).
 */
export function createBackendStartup({
  dataDir = defaultDataDir,
  warn = (message, error) => console.warn(message, error),
  schedule,
} = {}) {
  const store = new AppStore({
    storePath,
    noProjectSessionDir,
    samePath,
    noProjectName: NO_PROJECT_NAME,
  });
  const leases = new TaskLeaseService({
    dataDir,
    listTasks: () => [...store.listTasks(true), ...store.listTasks(true, "bot")],
    patchTask: (id, patch) => store.patchTask(id, patch),
    state: createTaskLeaseState(),
    warn,
  });

  const unavailable = [];
  const orphaned = [];
  // The resume itself needs a prompt path into a Pi session, which the Backend does
  // not have yet: the tasks are recorded so a caller can see what would be resumed.
  const orphanListener = (tasks) => {
    for (const task of tasks) orphaned.push(task.id);
  };

  const startup = new RuntimeStartup({
    loadServices: () => ({
      registerRestartResume: () => {
        leases.setOrphanedTaskListener(orphanListener);
      },
      reconcileOrphanedWorkingTasks: () => leases.reconcileOrphanedWorkingTasks(),
      ...Object.fromEntries(
        BACKEND_UNAVAILABLE_STARTUP_STEPS.map((step) => [step, () => {
          if (!unavailable.includes(step)) unavailable.push(step);
        }]),
      ),
    }),
    warn,
    ...(schedule ? { schedule } : {}),
  });

  return {
    startup,
    store,
    leases,
    /** Startup steps that had to be skipped because the Backend cannot run them yet. */
    unavailable: () => [...unavailable],
    /** Tasks that were reconciled and would be resumed once a runtime is attached. */
    orphaned: () => [...orphaned],
  };
}
