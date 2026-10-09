import { publicTaskSummary, publicTaskOperation } from "./task-collection-contract.mjs";
/** Pure assistance wire contract. Advice never answers/executes the pending permission. */
export const TASK_ASSISTANCE_ROUTES = Object.freeze({
  "tasks/[id]/progress": ["POST"], "tasks/[id]/next-action": ["POST"],
  "tasks/[id]/title": ["POST", "PATCH"], "tasks/[id]/permission/advice": ["POST"],
});
export function taskAssistanceTarget(path) {
  if (Object.hasOwn(TASK_ASSISTANCE_ROUTES, path)) return { route: path, params: {} };
  const match = /^tasks\/([^/]+)\/(progress|next-action|title|permission\/advice)$/.exec(path);
  if (!match) return null;
  try { return { route: `tasks/[id]/${match[2]}`, params: { id: decodeURIComponent(match[1]) } }; } catch { return null; }
}
export function taskAssistanceBodyLimit(path) {
  const route = taskAssistanceTarget(path)?.route;
  // Preserve owner's original UTF-16 raw-text budgets, including non-ASCII bodies.
  return route?.endsWith("/next-action") ? 320_000 : route?.endsWith("/permission/advice") ? 4096 : 32_000;
}
export function taskAssistanceCancelsOnDisconnect(path) { return taskAssistanceTarget(path)?.route.endsWith("/progress") === true; }
const record = v => v && typeof v === "object" && !Array.isArray(v);
function model(v) {
  if (!record(v) || typeof v.providerID !== "string" || typeof v.modelID !== "string") return null;
  const out = { providerID: v.providerID, modelID: v.modelID };
  if (v.accountId !== undefined) { if (typeof v.accountId !== "string") return null; out.accountId = v.accountId; }
  return out;
}
export function publicTaskAssistanceBody(route, value, status, method) {
  if (!Object.hasOwn(TASK_ASSISTANCE_ROUTES, route) || !record(value)) return null;
  const out = {};
  if (value.error !== undefined) { if (typeof value.error !== "string") return null; out.error = value.error; }
  if (status < 400) {
    if (out.error !== undefined) return null;
    if (route.endsWith("/title")) {
      out.task = publicTaskSummary(value.task); if (!out.task) return null;
      for (const name of ["title", "label"]) if (value[name] !== undefined) { if (typeof value[name] !== "string") return null; out[name] = value[name]; }
      if (method === "PATCH" && typeof out.title !== "string") return null;
    } else {
      if (value.source !== "direct") return null; out.source = "direct";
      if (route.endsWith("/progress")) {
        if (typeof value.answer !== "string" || typeof value.question !== "string" || typeof value.working !== "boolean" || !Number.isFinite(value.snapshotAt)) return null;
        Object.assign(out, { answer: value.answer, question: value.question, working: value.working, snapshotAt: value.snapshotAt });
      } else if (route.endsWith("/next-action")) {
        if (typeof value.suggestion !== "string" || !Array.isArray(value.suggestions) || value.suggestions.some(v => typeof v !== "string")) return null;
        Object.assign(out, { suggestion: value.suggestion, suggestions: [...value.suggestions] });
      } else { if (typeof value.advice !== "string") return null; out.advice = value.advice; }
    }
    if (value.model !== undefined) { out.model = model(value.model); if (!out.model) return null; }
    else if (!route.endsWith("/title")) return null;
  }
  if (value.operation !== undefined) { out.operation = publicTaskOperation(value.operation); if (!out.operation) return null; }
  return out;
}
