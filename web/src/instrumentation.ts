export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    // Reconcile durable work before the relay can report a half-started task.
    const { startBotCodeRelay, getTaskSummariesWithTodoProgress, listModelsForAccounts } = await import("@/lib/pi/harness");
    const { ensureRoutineScheduler } = await import("@/lib/routines");
    const { reconcileOrphanedWorkingTasks } = await import("@/lib/task-runtime-lease");
    const { reconcileRoomRuntime } = await import("@/lib/room-runtime");
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
  } catch (error) {
    console.warn("[bot-code-relay] startup scan unavailable", error);
  }
}
