/** Keep ordinary Goal Loop polling cheap; the strict auto-update scan is explicitly requested. */
export function readRuntimeControlState(runtime, { autoUpdate = false } = {}) {
  if (!runtime) throw new Error("runtime unavailable");
  if (!autoUpdate) return { taskIds: runtime.activeGoalLoopTaskIds() };
  try {
    return { autoUpdate: runtime.readAutoUpdateState?.() ?? null };
  } catch {
    // An unavailable background-work provider blocks auto-update, not manual recovery.
    return { autoUpdate: null };
  }
}
