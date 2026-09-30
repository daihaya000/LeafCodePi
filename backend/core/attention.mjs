/**
 * Attention (pending permission/question) routing and payload shape. The prompt services and the
 * task store stay with the caller; this owns which key a pending request belongs to and how an
 * attention item is built, so the Web route and the Backend's internal API answer identically.
 */

/**
 * The key a pending permission/question is stored under.
 *
 * A non-Bot task is always its own key. A Bot task may have its own pending request, but a
 * delegated Code session can also be waiting: several of them can wait at once, so the session
 * that actually owns the request wins instead of whichever session started first. When the request
 * id is not given (or nothing matches it) the Bot's own request is used, and with neither the Bot
 * key is kept.
 */
export function resolveAttentionSource({ taskId, isBotTask, requestId, ownRequestId, delegated }) {
  if (isBotTask !== true) return taskId;
  if (ownRequestId && (!requestId || ownRequestId === requestId)) return taskId;
  for (const entry of delegated ?? []) {
    if (entry?.requestId && (!requestId || entry.requestId === requestId)) return entry.taskId;
  }
  return taskId;
}

/**
 * One attention item, or null when nothing is waiting. Kinds are reported in the documented order
 * (permission before question) because the UI renders them in that order, and the origin task id is
 * present only when the pending key belongs to a delegated session.
 */
export function attentionItemForTask({ taskId, title, hasPermission, hasQuestion, originTaskId }) {
  const kinds = [];
  if (hasPermission === true) kinds.push("permission");
  if (hasQuestion === true) kinds.push("question");
  if (kinds.length === 0) return null;
  return {
    taskId,
    title,
    kinds,
    ...(originTaskId ? { originTaskId } : {}),
  };
}
