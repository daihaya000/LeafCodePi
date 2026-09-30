/**
 * The ordered effect sequence for one session event. Every step is injected —
 * tracking, task reads/writes, settle handling, identity projection, snapshotting
 * — so this module owns only the order, the early exits and what is re-read
 * between steps.
 *
 * Two early exits: an event that wants the task but has none left stops after the
 * first three trackers, and a turn start that cannot take the lease stops after
 * starting its run.
 */
export function runSessionEventEffects(event, deps) {
  deps.trackTurnLifecycleFlags();
  deps.trackProviderLimit();
  deps.noteWebSocketTransportFailure();

  const harnessAutoCompactionError = deps.isHarnessAutoCompactionError();
  const syncTask = deps.shouldSyncTaskFromSessionEvent(harnessAutoCompactionError);
  // Message/tool deltas arrive far more often than task metadata changes, so the
  // store is only read when the task is actually going to be touched.
  const task = syncTask ? deps.getTask() : undefined;
  if (deps.shouldSkipEventForMissingTask(syncTask, Boolean(task))) return { stopped: "missing-task" };
  deps.trackThroughputEvent();
  if (event.type === "agent_start" && !deps.runAgentStartTaskSync()) return { stopped: "lease-busy" };
  if (deps.shouldApplySettledStatus()) deps.applySettledStatus();
  if (event.type === "agent_settled") deps.finishSettledTurn();
  const compactionError = deps.compactionFailureMessage(harnessAutoCompactionError);
  if (compactionError) deps.setTaskStatusError(compactionError);
  if (task) deps.patchIdentity(task);
  deps.scheduleSnapshot();
  return { stopped: null };
}
