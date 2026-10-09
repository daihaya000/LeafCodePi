import { publicTaskCollectionBody, publicTaskOperation } from "./task-collection-contract.mjs";
export const TASK_CONVERSATION_ROUTES = Object.freeze({
  "tasks/[id]/prompt": ["POST"], "tasks/[id]/permission": ["POST"], "tasks/[id]/question": ["POST"],
});
export function taskConversationTarget(path) {
  if (Object.hasOwn(TASK_CONVERSATION_ROUTES, path)) return { route: path, params: {} };
  const match = /^tasks\/([^/]+)\/(prompt|permission|question)$/.exec(path);
  if (!match) return null;
  try { return { route: `tasks/[id]/${match[2]}`, params: { id: decodeURIComponent(match[1]) } }; }
  catch { return null; }
}
export function taskConversationBodyLimit(path) {
  const target = taskConversationTarget(path);
  return target?.route.endsWith("/prompt") ? 18 * 1024 * 1024 : target?.route.endsWith("/question") ? 16_384 : 4096;
}
export function publicTaskConversationBody(route, value, status) {
  if (!Object.hasOwn(TASK_CONVERSATION_ROUTES, route) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  if (route.endsWith("/prompt")) {
    if (status < 400 && !value.task) return null;
    return publicTaskCollectionBody({ ...(value.task !== undefined ? { task: value.task } : {}),
      ...(value.autoDecision !== undefined ? { autoDecision: value.autoDecision } : {}),
      ...(value.error !== undefined ? { error: value.error } : {}),
      ...(value.operation !== undefined ? { operation: value.operation } : {}) }, status);
  }
  const out = {};
  if (value.error !== undefined) { if (typeof value.error !== "string") return null; out.error = value.error; }
  if (status < 400) { if (value.ok !== true) return null; out.ok = true; }
  if (value.operation !== undefined) { out.operation = publicTaskOperation(value.operation); if (!out.operation) return null; }
  return out;
}
