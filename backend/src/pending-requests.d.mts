export interface PendingRequestRuntime {
  listPendingAttention(): Array<{ taskId: string; originTaskId?: string }>;
  pendingPermissionForTask(taskId: string): unknown;
  pendingQuestionForTask(taskId: string): unknown;
}
export function readPendingRequestSnapshots(runtime: PendingRequestRuntime | null | undefined): Array<{
  taskId: string;
  payload: { permissionRequest: unknown; questionRequest: unknown };
}>;
