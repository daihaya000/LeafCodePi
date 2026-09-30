/** The key a pending permission/question is stored under. */
export function resolveAttentionSource(input: {
  taskId: string;
  isBotTask: boolean;
  requestId?: string | undefined;
  ownRequestId?: string | null | undefined;
  delegated?: ReadonlyArray<{ taskId: string; requestId?: string | null }> | undefined;
}): string;

/** One attention item, or null when nothing is waiting. */
export function attentionItemForTask(input: {
  taskId: string;
  title: string;
  hasPermission: boolean;
  hasQuestion: boolean;
  originTaskId?: string | undefined;
}): { taskId: string; title: string; kinds: string[]; originTaskId?: string } | null;
