/**
 * Current owner-held approval/question DTOs, not the scheduler's event metadata.
 * Origins are included so Bot/Room streams use the same delegated-request routing as the owner UI.
 * Read afresh on every call: answering a request must remove it without waiting for another event.
 */
export function readPendingRequestSnapshots(runtime) {
  if (!runtime) return [];
  const taskIds = new Set();
  for (const item of runtime.listPendingAttention()) {
    taskIds.add(item.taskId);
    if (item.originTaskId) taskIds.add(item.originTaskId);
  }
  const snapshots = [];
  for (const taskId of taskIds) {
    const payload = {
      permissionRequest: runtime.pendingPermissionForTask(taskId) ?? null,
      questionRequest: runtime.pendingQuestionForTask(taskId) ?? null,
    };
    if (payload.permissionRequest !== null || payload.questionRequest !== null) {
      snapshots.push({ taskId, payload });
    }
  }
  return snapshots;
}
