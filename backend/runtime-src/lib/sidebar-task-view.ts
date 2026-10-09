/**
 * Fields of a task summary the sidebar never reads. The sidebar polls the whole list (500+ tasks),
 * and these (session file paths, working directories, ids and per-session flags) were about half of
 * every response. `?view=sidebar` drops them; every other caller keeps the full summary.
 */
export const SIDEBAR_OMITTED_TASK_FIELDS = [
  "sessionFile",
  "directory",
  "sessionId",
  "accountIdExplicit",
  "isolation",
  "manualAbortedAssistantId",
  "skillPermission",
  "permissionMode",
  "hangRetryCount",
  "revertLeafId",
  "createdAt",
  "titleAutoUpdate",
] as const;

export function sidebarTaskView<T extends object>(tasks: readonly T[]): T[] {
  return tasks.map((task) => {
    const view = { ...task } as Record<string, unknown>;
    for (const field of SIDEBAR_OMITTED_TASK_FIELDS) delete view[field];
    return view as T;
  });
}