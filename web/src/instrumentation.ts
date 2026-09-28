/** Let startup warmups finish before the label backfill calls Jev or the title model. */
const SESSION_LABEL_BACKFILL_DELAY_MS = 60_000;

/** Resume Code sessions interrupted by this restart once the worker has settled. */
async function registerRestartResume(
  setOrphanedTaskListener: typeof import("@/lib/task-runtime-lease").setOrphanedTaskListener,
  promptTask: typeof import("@/lib/pi/harness").promptTask,
): Promise<void> {
  if (typeof setOrphanedTaskListener !== "function" || typeof promptTask !== "function") return;
  const { handleOrphanedTasks } = await import("@/lib/pi/restart-resume");
  const { getTask } = await import("@/lib/store");
  const { isGoalLoopSessionOwned, readGoalLoopState } = await import("@/lib/pi/goal-loop-state");
  const { isRoomDelegatedCodeTask } = await import("@/lib/pi/bot-code-relay");
  setOrphanedTaskListener((tasks) => {
    handleOrphanedTasks(tasks, {
      getTask,
      promptTask: (id, prompt) => promptTask(id, prompt, undefined, { resume: true }),
      isGoalLoopOwned: (task) => isGoalLoopSessionOwned(readGoalLoopState(task.directory, task.sessionId)),
      isRoomDelegated: isRoomDelegatedCodeTask,
    });
  });
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    // Reconcile durable work before the relay can report a half-started task.
    const { startBotCodeRelay, getTaskSummariesWithTodoProgress, listModelsForAccounts, promptTask } = await import("@/lib/pi/harness");
    const { ensureRoutineScheduler } = await import("@/lib/routines");
    const { reconcileOrphanedWorkingTasks, setOrphanedTaskListener } = await import("@/lib/task-runtime-lease");
    const { reconcileRoomRuntime } = await import("@/lib/room-runtime");
    // Register before reconciling so this restart's orphans are offered for resume.
    await registerRestartResume(setOrphanedTaskListener, promptTask).catch((error) => {
      console.warn("[restart-resume] unavailable", error);
    });
    reconcileOrphanedWorkingTasks();
    startBotCodeRelay();
    ensureRoutineScheduler();
    reconcileRoomRuntime();
    // Codeサイドバーの初回取得がコールド一括解析（数百セッション・数秒）を待たない
    // よう起動時に裏で温める。失敗は利用時の通常構築に任せる。
    if (typeof getTaskSummariesWithTodoProgress === "function") {
      void getTaskSummariesWithTodoProgress(true).catch(() => undefined);
    }
    // /api/models の初回構築（1〜2秒）を起動裏で前倒し。失敗は初回リクエスト時の通常構築に任せる。
    if (typeof listModelsForAccounts === "function") {
      const { listAccounts } = await import("@/lib/accounts");
      void listModelsForAccounts(listAccounts()).catch(() => undefined);
    }
    // Sessions still showing "-" (every creation and turn-end classifier missed) are labelled in the background after startup.
    const { backfillMissingTaskLabels } = await import("@/lib/direct-title");
    if (typeof backfillMissingTaskLabels === "function") {
      const timer = setTimeout(() => {
        void backfillMissingTaskLabels().catch(() => undefined);
      }, SESSION_LABEL_BACKFILL_DELAY_MS);
      if (typeof timer.unref === "function") timer.unref();
    }
  } catch (error) {
    console.warn("[bot-code-relay] startup scan unavailable", error);
  }
}
