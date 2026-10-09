import { publicTaskSummary, publicTaskOperation } from "./task-collection-contract.mjs";
import { publicUiMessages } from "./task-lifecycle-contract.mjs";
/** Pure Task supervision/read-only child progress protocol. */
export const TASK_SUPERVISION_ROUTES = Object.freeze({ "tasks/[id]/supervisor": ["POST"], "tasks/[id]/subagents": ["GET"] });
export const TASK_SUPERVISION_BODY_LIMIT = 4096;
export function taskSupervisionTarget(path) {
  if (Object.hasOwn(TASK_SUPERVISION_ROUTES, path)) return { route: path, params: {} };
  const match = /^tasks\/([^/]+)\/(supervisor|subagents)$/.exec(path); if (!match) return null;
  try { return { route: `tasks/[id]/${match[2]}`, params: { id: decodeURIComponent(match[1]) } }; } catch { return null; }
}
const record = v => v && typeof v === "object" && !Array.isArray(v);
const finite = v => typeof v === "number" && Number.isFinite(v);
export function publicSubagentRun(value) {
  if (!record(value) || typeof value.runId !== "string" || typeof value.agent !== "string" || !["running","completed","error","stale"].includes(value.status) ||
    !finite(value.startedAtMs) || !finite(value.lastActivityAtMs) || !(value.currentTool === null || typeof value.currentTool === "string") || typeof value.truncated !== "boolean") return null;
  const messages = publicUiMessages(value.messages); if (!messages) return null;
  const out = { runId: value.runId, agent: value.agent, status: value.status, startedAtMs: value.startedAtMs, lastActivityAtMs: value.lastActivityAtMs,
    currentTool: value.currentTool, truncated: value.truncated, messages };
  if (value.index !== undefined) { if (!finite(value.index)) return null; out.index = value.index; }
  for (const key of ["provider","model"]) if (value[key] !== undefined) { if (typeof value[key] !== "string") return null; out[key] = value[key]; }
  return out;
}
export function publicTaskSupervisionBody(route, value, status) {
  if (!Object.hasOwn(TASK_SUPERVISION_ROUTES, route) || !record(value)) return null;
  const out = {};
  if (value.error !== undefined) { if (typeof value.error !== "string") return null; out.error = value.error; }
  if (status < 400) {
    if (out.error !== undefined) return null;
    if (route.endsWith("/supervisor")) { out.task = publicTaskSummary(value.task); if (!out.task) return null; }
    else { if (!Array.isArray(value.runs) || value.runs.length > 8) return null; out.runs = value.runs.map(publicSubagentRun); if (out.runs.some(v => v === null)) return null; }
  }
  if (value.operation !== undefined && route.endsWith("/supervisor")) { out.operation = publicTaskOperation(value.operation); if (!out.operation) return null; }
  return out;
}
