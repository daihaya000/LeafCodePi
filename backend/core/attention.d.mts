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

/** The attention keys a teardown clears, the task itself first. */
export function attentionClearTargets(input: {
  taskId: string;
  isBotTask: boolean;
  includeDelegatedCode: boolean;
  delegatedTaskIds?: readonly string[] | undefined;
}): string[];

/** Where an attention event is emitted: the task, plus a distinct origin when there is one. */
export function attentionEmitPlan(input: {
  taskId: string;
  originTaskId?: string | null | undefined;
}): { taskId: string; origin: string | null };
