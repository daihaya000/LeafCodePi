import { RuntimeStartup, type RuntimeStartupServices } from "@backend-core/runtime-startup.mjs";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

const globals = globalThis as typeof globalThis & {
  __leafcodeRuntimeStartup?: RuntimeStartup;
};

async function loadServices(): Promise<RuntimeStartupServices> {
  const harness = await import("@/lib/pi/harness");
  const { ensureRoutineScheduler } = await import("@/lib/routines");
  const { reconcileOrphanedWorkingTasks, setOrphanedTaskListener } = await import("@/lib/task-runtime-lease");
  const { reconcileRoomRuntime } = await import("@/lib/room-runtime");
  return {
    registerRestartResume: async () => {
      if (typeof setOrphanedTaskListener !== "function" || typeof harness.promptTask !== "function") return;
      const { handleOrphanedTasks } = await import("@/lib/pi/restart-resume");
      const { getTask } = await import("@/lib/store");
      const { isGoalLoopSessionOwned, readGoalLoopState } = await import("@/lib/pi/goal-loop-state");
      const { isRoomDelegatedCodeTask } = await import("@/lib/pi/bot-code-relay");
      setOrphanedTaskListener((tasks) => {
        handleOrphanedTasks(tasks, {
          getTask,
          promptTask: (id, prompt) => harness.promptTask(id, prompt, undefined, { resume: true }),
          isGoalLoopOwned: (task) => isGoalLoopSessionOwned(readGoalLoopState(task.directory, task.sessionId)),
          isRoomDelegated: isRoomDelegatedCodeTask,
        });
      });
    },
    reconcileOrphanedWorkingTasks,
    // The relay publishes work by prompting a session, so only the runtime owner may run it. After
    // the cutover the Backend owns the relay; a second one here would double-write the outbox and
    // repeatedly fail to deliver.
    startBotCodeRelay: () => {
      if (localRuntimeBlocked()) return;
      harness.startBotCodeRelay();
    },
    ensureRoutineScheduler,
    reconcileRoomRuntime,
    warmTaskSummaries: typeof harness.getTaskSummariesWithTodoProgress === "function"
      ? () => harness.getTaskSummariesWithTodoProgress(true)
      : undefined,
    warmModels: typeof harness.listModelsForAccounts === "function" ? async () => {
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
  globals.__leafcodeRuntimeStartup ??= new RuntimeStartup({ loadServices });
  return globals.__leafcodeRuntimeStartup.start();
}
