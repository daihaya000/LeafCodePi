/**
 * Room recovery decisions after a worker crash or restart. Storage, task
 * records and leases are injected; nothing here reads ambient state.
 */

/**
 * Working placeholders that nothing will ever settle. A message is stale once
 * older than `staleMs`; a Bot turn is additionally kept when it is merely slow:
 * this worker still owns the run, another worker holds a live task lease, or
 * the task record is still being updated by someone. Messages without a Bot
 * (no task to consult) are stale by age alone.
 */
export function findStaleRoomTurns(messages, { now, staleMs, taskIdFor, isRunOwned, hasActiveLease, getTask }) {
  return messages.filter((message) => {
    if (message.status !== "working" || now - message.createdAt <= staleMs) return false;
    if (!message.botId) return true;
    const taskId = taskIdFor(message.botId);
    if (isRunOwned(taskId)) return false;
    // Cross-worker: a live Code session holds a disk lease even when the owned map is empty.
    if (hasActiveLease(taskId)) return false;
    const task = getTask(taskId);
    const touchedAt = task ? Date.parse(task.updatedAt) : Number.NaN;
    return !(task?.status === "working" && Number.isFinite(touchedAt) && now - touchedAt <= staleMs);
  });
}

/**
 * Startup pass over every room: settle abandoned placeholders, then settle
 * ready handoffs and redeliver only when some were settled. Delivery is
 * detached, and its failure is only warned so one room cannot block the rest.
 */
export function runRoomReconcile(deps) {
  for (const room of deps.listRooms()) {
    deps.settleStaleTurns(room.id);
    if (deps.settleHandoffs(room.id) > 0) {
      void Promise.resolve(deps.deliverHandoffs(room.id)).catch((error) => {
        deps.warn(
          "[room-runtime] startup handoff recovery failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
    }
  }
}
