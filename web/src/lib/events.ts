/** Fire when projects/tasks change so the sidebar can refresh. Debounced to avoid SSE floods. */

const DEBOUNCE_MS = 400;

let timer: ReturnType<typeof setTimeout> | null = null;
let botSidebarRefreshId = 0;

export function notifyTasksChanged() {
  if (typeof window === "undefined") return;
  if (timer != null) return;
  timer = setTimeout(() => {
    timer = null;
    // タイマー発火時にも window を再検査する。テスト環境の破棄などで
    // 発火時に window が消えていると未処理例外になるため。
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event("webui:tasks-changed"));
  }, DEBOUNCE_MS);
}

/** Notify the Bot sidebar after a Bot or room mutation. */
export function notifyBotSidebarChanged() {
  if (typeof window === "undefined") return;
  const refresh = `${Date.now()}-${++botSidebarRefreshId}`;
  window.dispatchEvent(new CustomEvent("webui:bot-sidebar-changed", { detail: { refresh } }));
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
