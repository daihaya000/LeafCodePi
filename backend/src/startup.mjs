import { AppStore } from "../core/app-store.mjs";
import { dataDir as defaultDataDir, noProjectSessionDir, samePath, storePath } from "../core/app-paths.mjs";
import { createTaskLeaseState, ORPHANED_WORKING_TASK_ERROR, TaskLeaseService } from "../core/task-runtime-lease.mjs";
import { RuntimeStartup } from "../core/runtime-startup.mjs";
import { RestartResumeService, restartResumeRefusal, restartResumeSkipReason } from "../core/restart-resume.mjs";
import { GoalLoopStateStore } from "../core/goal-loop-state.mjs";
import { clampGoalLoopCooldownSeconds, clampGoalLoopMaxTurns, isGoalLoopSessionOwnedStatus } from "../core/goal-loop-settings.mjs";

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
  /**
   * Sends the restart-resume prompt into a Pi session. Until the runtime owner supplies
   * this, orphaned tasks are only classified: no resume is attempted and no retry budget
   * is spent, so the Web process stays the only writer while it still owns them.
   */
  promptTask,
  /**
   * Loads the bundled Pi runtime. Left out by default: the Web process still owns the SDK, so the
   * Backend only attaches a runtime when the host explicitly asks for it.
   */
  loadRuntime,
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
  let runtimeStatus = { ok: false, reason: "not-requested" };
  const resumePending = [];
  const resumeSkipped = [];
  const goalLoopStore = new GoalLoopStateStore({
    dataDir,
    clampMaxTurns: (value) => clampGoalLoopMaxTurns(value),
    clampCooldownSeconds: (value) => clampGoalLoopCooldownSeconds(value),
  });
  /**
   * The resume itself needs a prompt path into a Pi session, which the Backend does not
   * have yet. Classification uses the same core ladder as the resume path, but nothing
   * is attempted and no retry budget is spent: a task is only listed as resumable once a
   * runtime is attached, and every refusal keeps its reason.
   */
  const restartResume = new RestartResumeService({ dataDir, orphanedTaskError: ORPHANED_WORKING_TASK_ERROR });
  const runtimeAttached = typeof promptTask === "function";
  const goalLoopOwned = (task) => Boolean(
    task.sessionId && isGoalLoopSessionOwnedStatus(goalLoopStore.read(task.directory, task.sessionId)?.status),
  );

  const orphanListener = (tasks) => {
    for (const task of tasks) {
      orphaned.push(task.id);
      // Staleness is judged on the pre-patch snapshot the reconciler captured, while
      // status/error come from the row it just wrote.
      const skip = restartResumeSkipReason(task, Date.now());
      if (skip) {
        resumeSkipped.push({ id: task.id, reason: skip });
        continue;
      }
      const stored = store.getTask(task.id) ?? task;
      const loop = stored.sessionId ? goalLoopStore.read(stored.directory, stored.sessionId) : null;
      const refusal = restartResumeRefusal({
        task: stored,
        orphanedTaskError: ORPHANED_WORKING_TASK_ERROR,
        isRoomDelegated: false,
        isGoalLoopOwned: isGoalLoopSessionOwnedStatus(loop?.status),
      });
      if (refusal) resumeSkipped.push({ id: task.id, reason: refusal });
      else resumePending.push(task.id);
    }
    if (!runtimeAttached) return;
    // The same ladder runs again inside the service, which also spends the retry budget
    // and only then prompts; Room delegation has no owner in this process yet, so a Room
    // task would be classified as resumable here once the relay moves over.
    restartResume.handleOrphanedTasks(tasks, {
      getTask: (id) => store.getTask(id),
      promptTask,
      isGoalLoopOwned: goalLoopOwned,
      isRoomDelegated: () => false,
      log: warn,
      ...(schedule ? { schedule } : {}),
    });
  };

  const startup = new RuntimeStartup({
    loadServices: () => ({
      registerRestartResume: () => {
        leases.setOrphanedTaskListener(orphanListener);
      },
      reconcileOrphanedWorkingTasks: () => leases.reconcileOrphanedWorkingTasks(),
      // The runtime is attached before anything that needs it; a failure is reported, never thrown,
      // so the startup prefix still completes and the host decides what readiness means.
      ...(typeof loadRuntime === "function"
        ? { loadRuntime: async () => { runtimeStatus = await loadRuntime(); } }
        : {}),
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
    /** Reconciled tasks that are resumable as soon as a Pi runtime is attached. */
    resumePending: () => [...resumePending],
    /** Reconciled tasks that must not be resumed, each with the core ladder's reason. */
    resumeSkipped: () => resumeSkipped.map((entry) => ({ ...entry })),
    /** Whether a Pi runtime was supplied, so resumes actually run. */
    resumesOrphanedTasks: () => runtimeAttached,
    /** Whether the bundled runtime was attached, and why not when it was not. */
    runtimeStatus: () => ({ ...runtimeStatus }),
  };
}
