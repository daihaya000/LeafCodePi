/** Fire when projects/tasks change so the sidebar can refresh. */
export function notifyTasksChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("webui:tasks-changed"));
  }
}
