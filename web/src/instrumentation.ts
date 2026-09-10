export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    // Reconcile durable work before the relay can report a half-started task.
    const { startBotCodeRelay } = await import("@/lib/pi/harness");
    const { ensureRoutineScheduler } = await import("@/lib/routines");
    const { reconcileOrphanedWorkingTasks } = await import("@/lib/task-runtime-lease");
    const { reconcileRoomRuntime } = await import("@/lib/room-runtime");
    reconcileOrphanedWorkingTasks();
    startBotCodeRelay();
    ensureRoutineScheduler();
    reconcileRoomRuntime();
  } catch (error) {
    console.warn("[bot-code-relay] startup scan unavailable", error);
  }
}
