/** Fire when projects/tasks change so the sidebar can refresh. Debounced to avoid SSE floods. */

const DEBOUNCE_MS = 400;
const BOT_SIDEBAR_DEDUPE_MS = 1_000;

type TasksChangedDetail = { projectId: string };

let timer: ReturnType<typeof setTimeout> | null = null;
let pendingProjectId: string | undefined;
let botSidebarRefreshId = 0;
let lastBotSidebarDedupeKey: string | undefined;
let lastBotSidebarDedupeAt = 0;

function dispatchTasksChanged(projectId?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    projectId
      ? new CustomEvent<TasksChangedDetail>("webui:tasks-changed", { detail: { projectId } })
      : new Event("webui:tasks-changed"),
  );
}

export function notifyTasksChanged(projectId?: string) {
  if (typeof window === "undefined") return;
  if (projectId) pendingProjectId = projectId;
  if (timer != null) return;
  timer = setTimeout(() => {
    timer = null;
    const changedProjectId = pendingProjectId;
    pendingProjectId = undefined;
    // タイマー発火時にも window を再検査する。テスト環境の破棄などで
    // 発火時に window が消えていると未処理例外になるため。
    dispatchTasksChanged(changedProjectId);
  }, DEBOUNCE_MS);
}

/** Notify the Bot sidebar after a Bot or room mutation. */
export function notifyBotSidebarChanged(dedupeKey?: string) {
  if (typeof window === "undefined") return;
  const now = Date.now();
  if (dedupeKey && dedupeKey === lastBotSidebarDedupeKey && now - lastBotSidebarDedupeAt < BOT_SIDEBAR_DEDUPE_MS) return;
  if (dedupeKey) {
    lastBotSidebarDedupeKey = dedupeKey;
    lastBotSidebarDedupeAt = now;
  }
  const refresh = `${now}-${++botSidebarRefreshId}`;
  window.dispatchEvent(new CustomEvent("webui:bot-sidebar-changed", { detail: { refresh } }));
}

/** Test helper — flush pending debounce immediately. */
export function flushNotifyTasksChangedForTests() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  const changedProjectId = pendingProjectId;
  pendingProjectId = undefined;
  dispatchTasksChanged(changedProjectId);
}
