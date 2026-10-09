import { publicTaskSummary, publicTaskOperation } from "./task-collection-contract.mjs";
export const TASK_EXECUTION_SETTINGS_ROUTES = Object.freeze({
  "tasks/[id]/model": ["POST"], "tasks/[id]/thinking": ["POST"],
  "tasks/[id]/agent": ["POST"], "tasks/[id]/goal-loop-auto-model": ["PUT"],
});
export const TASK_EXECUTION_SETTINGS_BODY_LIMIT = 4096;
export function taskExecutionSettingsTarget(path) {
  if (Object.hasOwn(TASK_EXECUTION_SETTINGS_ROUTES, path)) return { route: path, params: {} };
  const match = /^tasks\/([^/]+)\/(model|thinking|agent|goal-loop-auto-model)$/.exec(path);
  if (!match) return null;
  try { return { route: `tasks/[id]/${match[2]}`, params: { id: decodeURIComponent(match[1]) } }; }
  catch { return null; }
}
export function publicTaskExecutionSettingsBody(route, value, status) {
  if (!Object.hasOwn(TASK_EXECUTION_SETTINGS_ROUTES, route) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  if (value.error !== undefined) { if (typeof value.error !== "string") return null; out.error = value.error; }
  if (status < 400) {
    if (route.endsWith("/goal-loop-auto-model")) { if (typeof value.enabled !== "boolean") return null; out.enabled = value.enabled; }
    else { out.task = publicTaskSummary(value.task); if (!out.task) return null; }
  }
  if (value.operation !== undefined) { out.operation = publicTaskOperation(value.operation); if (!out.operation) return null; }
  return out;
}
