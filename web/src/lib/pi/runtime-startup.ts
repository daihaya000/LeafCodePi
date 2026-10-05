import { RuntimeStartup, type RuntimeStartupServices } from "@backend-core/runtime-startup.mjs";
import { dataDir } from "@backend-core/app-paths.mjs";
import { acquireRuntimeOwner } from "@backend-core/runtime-owner-lock.mjs";
import { isGoalLoopCommandApplied } from "@/lib/pi/goal-loop-command";
import { localRuntimeBlocked, setRuntimeOwnerUnavailable } from "@/lib/pi/runtime-ownership";

const globals = globalThis as typeof globalThis & {
  __leafcodeRuntimeStartup?: RuntimeStartup;
  __leafcodeRuntimeOwnerRelease?: () => void;
  __leafcodeRuntimeOwnerUnavailable?: boolean;
};

async function loadServices(): Promise<RuntimeStartupServices> {
  const harness = await import("@/lib/pi/harness");
  const { ensureRoutineScheduler: startRoutineScheduler } = await import("@/lib/routines");
  const { ensureCodexResetScheduler } = await import("@/lib/codexbar/reset-scheduler");
  const { reconcileOrphanedWorkingTasks: reconcileLeases, setOrphanedTaskListener, setLeaseLostListener } = await import("@/lib/task-runtime-lease");
  const { reconcileRoomRuntime: reconcileRooms } = await import("@/lib/room-runtime");
  return {
    registerRestartResume: async () => {
      // Recovery prompts sessions, so it belongs to the runtime owner. After the cutover the Backend
      // registers its own listener; one here would only spend its retry budget on refused prompts.
      if (localRuntimeBlocked()) return;
      if (typeof setLeaseLostListener === "function" && typeof harness.abortTaskSessionsAfterLeaseLoss === "function") {
        setLeaseLostListener((taskIds) => harness.abortTaskSessionsAfterLeaseLoss(taskIds));
      }
      if (typeof setOrphanedTaskListener !== "function" || typeof harness.promptTask !== "function") return;
      const { handleOrphanedTasks, isGoalLoopRestartResumable } = await import("@/lib/pi/restart-resume");
      const { getTask } = await import("@/lib/store");
      const { isGoalLoopSessionOwned, readGoalLoopState } = await import("@/lib/pi/goal-loop-state");
      const { isRoomDelegatedCodeTask } = await import("@/lib/pi/bot-code-relay");
      setOrphanedTaskListener((tasks) => {
        handleOrphanedTasks(tasks, {
          getTask,
          promptTask: (id, prompt) => harness.promptTask(id, prompt, undefined, { resume: true }),
          ...(typeof harness.goalLoopCommand === "function"
            ? { resumeGoalLoop: async (id: string, prompt: string) => {
                const loop = await harness.goalLoopCommand(id, { action: "resume", restartPrompt: prompt });
                if (!isGoalLoopCommandApplied("resume", loop)) {
                  throw Object.assign(new Error("Goal Loop の再起動復帰が反映されませんでした"), { status: 409 });
                }
                return loop;
              } }
            : {}),
          isGoalLoopOwned: (task) => isGoalLoopSessionOwned(readGoalLoopState(task.directory, task.sessionId)),
          canResumeGoalLoop: (task) => isGoalLoopRestartResumable(readGoalLoopState(task.directory, task.sessionId)),
          isRoomDelegated: isRoomDelegatedCodeTask,
        });
      });
    },
    // Reconciliation writes the store and can prompt; after the cutover the Backend does both.
    reconcileOrphanedWorkingTasks: () => {
      if (localRuntimeBlocked()) return;
      reconcileLeases();
    },
    // The relay publishes work by prompting a session, so only the runtime owner may run it. After
    // the cutover the Backend owns the relay; a second one here would double-write the outbox and
    // repeatedly fail to deliver.
    startBotCodeRelay: () => {
      if (localRuntimeBlocked()) return;
      harness.startBotCodeRelay();
    },
    // Routines run by prompting a session, so the scheduler belongs to the runtime owner too. Its
    // tick takes a cross-process lock, but a scheduler here would only fail every run after the
    // cutover while the Backend's own scheduler does the work.
    ensureRoutineScheduler: () => {
      if (localRuntimeBlocked()) return;
      startRoutineScheduler();
      ensureCodexResetScheduler();
    },
    // Room recovery settles abandoned turns and delivers ready handoffs, which prompts a session.
    reconcileRoomRuntime: () => {
      if (localRuntimeBlocked()) return;
      reconcileRooms();
    },
    warmTaskSummaries: typeof harness.getTaskSummariesWithTodoProgress === "function"
      ? () => harness.getTaskSummariesWithTodoProgress(true)
      : undefined,
    warmModels: typeof harness.listModelsForAccounts === "function" ? async () => {
      // Client Web must not warm the Pi model catalog after the Backend owns the runtime.
      if (localRuntimeBlocked()) return;
      const { listAccounts } = await import("@/lib/accounts");
      return harness.listModelsForAccounts(listAccounts());
    } : undefined,
    backfillMissingTaskLabels: async () => {
      const { backfillMissingTaskLabels } = await import("@/lib/direct-title");
      if (typeof backfillMissingTaskLabels === "function") return backfillMissingTaskLabels();
    },
  };
}

/** One owner per process, including Next route bundles and development reloads. */
export function startRuntimeServices(): Promise<void> {
  if (globals.__leafcodeRuntimeOwnerUnavailable) {
    throw new Error("runtime owner slot is unavailable");
  }
  // Production Web is a client; only a local dev owner claims the shared runtime slot.
  if (!localRuntimeBlocked() && !globals.__leafcodeRuntimeOwnerRelease) {
    try {
      globals.__leafcodeRuntimeOwnerRelease = acquireRuntimeOwner(dataDir());
      setRuntimeOwnerUnavailable(false);
    } catch (error) {
      setRuntimeOwnerUnavailable(true);
      throw error;
    }
  }
  globals.__leafcodeRuntimeStartup ??= new RuntimeStartup({ loadServices });
  return globals.__leafcodeRuntimeStartup.start();
}
