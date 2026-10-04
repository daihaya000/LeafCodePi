import { AppStore } from "../core/app-store.mjs";
import { toBotDto } from "../core/bot-config.mjs";
import { BotFileStore } from "../core/bot-store.mjs";
import { BOT_DEFAULT_TOOL_NAMES, BOT_TOOL_NAMES } from "../../shared/bot-tools.mjs";
import { dataDir as defaultDataDir, noProjectSessionDir, samePath, storePath } from "../core/app-paths.mjs";
import { join } from "node:path";
import { createTaskLeaseState, ORPHANED_WORKING_TASK_ERROR, TaskLeaseService } from "../core/task-runtime-lease.mjs";
import { RuntimeStartup } from "../core/runtime-startup.mjs";
import {
  RestartResumeService,
  isGoalLoopRestartResumable,
  restartResumeRefusal,
  restartResumeSkipReason,
} from "../core/restart-resume.mjs";
import { GoalLoopStateStore } from "../core/goal-loop-state.mjs";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  isGoalLoopLiveStatus,
  isGoalLoopSessionOwnedStatus,
} from "../core/goal-loop-settings.mjs";

/** Must match NO_PROJECT_NAME in shared/types.ts (the Backend cannot import TypeScript). */
const NO_PROJECT_NAME = "プロジェクトなし";

/**
 * The Backend's startup sequence: it owns the application store and the task lease, so stale leases
 * are reclaimed and working tasks without a live lease are reconciled to error before anything else
 * touches them. The owner-only services (relay, routine scheduler, room recovery) run against the
 * attached runtime, and one that cannot start is recorded in `unavailable()` so readiness never
 * claims it runs. The host's readiness stays the caller's decision.
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
  /** Explicit owner initialization (e.g. native MCP provider installation) before runtime publication
   * or any resume/relay/scheduler. Unset keeps current startup unchanged. Must acknowledge undefined;
   * failure blocks startup, without rollback of effects already started inside the callback. */
  initializeRuntime,
} = {}) {
  if (initializeRuntime !== undefined && typeof initializeRuntime !== "function") {
    throw new Error("initializeRuntime must be a function");
  }
  const store = new AppStore({
    storePath,
    noProjectSessionDir,
    samePath,
    noProjectName: NO_PROJECT_NAME,
    onBackupError: (error) => warn("Application store backup failed", error),
  });
  // The Bot store reads the same files the Web app does; the tool vocabulary comes from the shared
  // module so both processes validate stored tool names identically.
  const bots = new BotFileStore({
    botsRoot: () => join(dataDir(), "bots"),
    toolNames: BOT_TOOL_NAMES,
    defaultToolNames: BOT_DEFAULT_TOOL_NAMES,
  });
  const listBots = () =>
    bots.listConfigs().map((config) =>
      toBotDto(config, { readSoulText: () => bots.readSoulText(config.id), toolNames: BOT_TOOL_NAMES }),
    );
  const getBot = (id) => {
    // An unusable id is a miss, not a crash: `readConfig` validates the id and the file shape.
    let config;
    try { config = bots.readConfig(id); } catch { return null; }
    return config
      ? toBotDto(config, { readSoulText: () => bots.readSoulText(config.id), toolNames: BOT_TOOL_NAMES })
      : null;
  };
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
  /**
   * Whether a resume will actually be attempted. A supplied prompt path is not enough on its own:
   * the runtime must be attached, or every attempt would fail and spend the retry budget that the
   * detached case deliberately keeps untouched.
   */
  const resumesOrphaned = () => typeof promptTask === "function" && runtimeStatus.ok === true;
  const goalLoopStateForTask = (task) =>
    task.sessionId ? goalLoopStore.read(task.directory, task.sessionId) : null;
  const goalLoopOwned = (task) => isGoalLoopSessionOwnedStatus(goalLoopStateForTask(task)?.status);
  const canResumeGoalLoop = (task) => {
    const runtime = runtimeStatus.ok === true ? runtimeStatus.runtime : null;
    return isGoalLoopRestartResumable(goalLoopStateForTask(task)) &&
      typeof runtime?.goalLoopCommand === "function";
  };
  const resumeGoalLoop = async (id, prompt) => {
    const runtime = runtimeStatus.ok === true ? runtimeStatus.runtime : null;
    if (typeof runtime?.goalLoopCommand !== "function") {
      throw Object.assign(new Error("Goal Loop runtime unavailable"), { status: 503 });
    }
    const loop = await runtime.goalLoopCommand(id, { action: "resume", restartPrompt: prompt });
    if (!loop || !isGoalLoopLiveStatus(loop.status)) {
      throw Object.assign(new Error("Goal Loop restart resume was not applied"), { status: 409 });
    }
    return loop;
  };

  /**
   * Runs one startup step against the attached runtime, if any. A detached Backend does nothing:
   * readiness already refuses on the missing runtime, so the step is not reported as unavailable.
   * A step that fails is reported instead of failing the whole sequence, so readiness never claims
   * a service runs when it does not.
   */
  const runRuntimeStep = (name) => {
    const runtime = runtimeStatus.ok === true ? runtimeStatus.runtime : null;
    const step = runtime?.[name];
    if (typeof step !== "function") return;
    try {
      step();
    } catch {
      if (!unavailable.includes(name)) unavailable.push(name);
    }
  };

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
      const loop = goalLoopStateForTask(stored);
      const loopOwned = isGoalLoopSessionOwnedStatus(loop?.status);
      const refusal = restartResumeRefusal({
        task: stored,
        orphanedTaskError: ORPHANED_WORKING_TASK_ERROR,
        isRoomDelegated: false,
        isGoalLoopOwned: loopOwned,
        canResumeGoalLoop: loopOwned && canResumeGoalLoop(stored),
      });
      if (refusal) resumeSkipped.push({ id: task.id, reason: refusal });
      else resumePending.push(task.id);
    }
    if (!resumesOrphaned()) return;
    // The same ladder runs again inside the service, which also spends the retry budget
    // and only then prompts; Room delegation has no owner in this process yet, so a Room
    // task would be classified as resumable here once the relay moves over.
    restartResume.handleOrphanedTasks(tasks, {
      getTask: (id) => store.getTask(id),
      promptTask,
      resumeGoalLoop,
      isGoalLoopOwned: goalLoopOwned,
      canResumeGoalLoop,
      isRoomDelegated: () => false,
      log: warn,
      ...(schedule ? { schedule } : {}),
    });
  };

  const startup = new RuntimeStartup({
    loadServices: () => ({
      registerRestartResume: () => {
        leases.setOrphanedTaskListener(orphanListener);
        const alreadyNotified = new Set(orphaned);
        const persistedOrphans = [...store.listTasks(true), ...store.listTasks(true, "bot")]
          .filter((task) => task.status === "error" && task.error === ORPHANED_WORKING_TASK_ERROR && !alreadyNotified.has(task.id));
        if (persistedOrphans.length > 0) orphanListener(persistedOrphans);
      },
      reconcileOrphanedWorkingTasks: () => leases.reconcileOrphanedWorkingTasks(),
      // The loader may report detachment so the reconciliation prefix can still run. Owner
      // initialization failure also leaves the runtime detached — no adapter fallback and no
      // half-installed provider — but it must not take the whole Backend down: the failed step is
      // reported in health so an operator can fix the config and restart.
      ...(typeof loadRuntime === "function"
        ? { loadRuntime: async () => {
            const loaded = await loadRuntime();
            if (loaded.ok === true && initializeRuntime) {
              try {
                if (await initializeRuntime(loaded.runtime) !== undefined) throw new Error("invalid initialization acknowledgment");
              } catch {
                runtimeStatus = { ok: false, reason: "initialization-failed" };
                if (!unavailable.includes("initializeRuntime")) unavailable.push("initializeRuntime");
                return;
              }
            }
            runtimeStatus = loaded;
          } }
        : {}),
      // The relay publishes Bot Code work by prompting a session, which only the owner can do.
      startBotCodeRelay: () => {
        runRuntimeStep("startBotCodeRelay");
      },
      // Routines are run by prompting a session, so the scheduler belongs to the owner as well.
      ensureRoutineScheduler: () => {
        runRuntimeStep("ensureRoutineScheduler");
      },
      // Room recovery settles abandoned turns and delivers ready handoffs, which prompts a session.
      reconcileRoomRuntime: () => {
        runRuntimeStep("reconcileRoomRuntime");
      },
    }),
    warn,
    ...(schedule ? { schedule } : {}),
  });

  return {
    startup,
    store,
    leases,
    /** Startup steps that failed to start. Empty means every step of the sequence ran. */
    unavailable: () => [...unavailable],
    /** Tasks that were reconciled and would be resumed once a runtime is attached. */
    orphaned: () => [...orphaned],
    /** Reconciled tasks that are resumable as soon as a Pi runtime is attached. */
    resumePending: () => [...resumePending],
    /** Reconciled tasks that must not be resumed, each with the core ladder's reason. */
    resumeSkipped: () => resumeSkipped.map((entry) => ({ ...entry })),
    /** Whether a resume will actually be attempted (a prompt path *and* an attached runtime). */
    resumesOrphanedTasks: () => resumesOrphaned(),
    /** Whether the bundled runtime was attached, and why not when it was not. */
    runtimeStatus: () => ({ ...runtimeStatus }),
    /** The attached runtime, or null while nothing is attached. */
    runtime: () => (runtimeStatus.ok === true ? runtimeStatus.runtime : null),
    /** The Bot store this process reads: the same files the Web app writes. */
    bots: { list: listBots, get: getBot },
  };
}
