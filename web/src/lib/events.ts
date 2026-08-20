/** Fire when projects/tasks change so the sidebar can refresh. Debounced to avoid SSE floods. */

const DEBOUNCE_MS = 400;

let timer: ReturnType<typeof setTimeout> | null = null;

export function notifyTasksChanged() {
  if (typeof window === "undefined") return;
  if (timer != null) return;
  timer = setTimeout(() => {
    timer = null;
    window.dispatchEvent(new Event("webui:tasks-changed"));
  }, DEBOUNCE_MS);
}

/** Test helper — flush pending debounce immediately. */
export function flushNotifyTasksChangedForTests() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("webui:tasks-changed"));
  }
}
