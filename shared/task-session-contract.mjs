import { publicTaskSummary, publicTaskOperation } from "./task-collection-contract.mjs";
import { publicTaskDetail } from "./task-lifecycle-contract.mjs";
import { publicProjectBody } from "./project-contract.mjs";
/** Pure conversation-tree and workspace-promotion wire protocol. */
export const TASK_SESSION_ROUTES = Object.freeze(Object.fromEntries(["fork", "revert", "unrevert", "promote"].map(action => [`tasks/[id]/${action}`, ["POST"]])));
export const TASK_SESSION_BODY_LIMIT = 4096;
export function taskSessionTarget(path) {
  if (Object.hasOwn(TASK_SESSION_ROUTES, path)) return { route: path, params: {} };
  const match = /^tasks\/([^/]+)\/(fork|revert|unrevert|promote)$/.exec(path);
  if (!match) return null;
  try { return { route: `tasks/[id]/${match[2]}`, params: { id: decodeURIComponent(match[1]) } }; }
  catch { return null; }
}
function attachment(value) {
  if (!value || typeof value !== "object" || typeof value.uri !== "string" || typeof value.mime !== "string" || (value.name !== undefined && typeof value.name !== "string")) return null;
  return { uri: value.uri, mime: value.mime, ...(value.name !== undefined ? { name: value.name } : {}) };
}
export function publicTaskSessionBody(route, value, status) {
  if (!Object.hasOwn(TASK_SESSION_ROUTES, route) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  if (value.error !== undefined) { if (typeof value.error !== "string") return null; out.error = value.error; }
  if (status < 400) {
    out.task = /\/(unrevert|revert)$/.test(route) ? publicTaskDetail(value.task) : publicTaskSummary(value.task);
    if (!out.task || out.error !== undefined) return null;
    if (/\/(fork|revert)$/.test(route)) {
      if (typeof value.text !== "string") return null;
      out.text = value.text;
      for (const key of ["images", "files"]) {
        if (!Array.isArray(value[key])) return null;
        out[key] = value[key].map(attachment);
        if (out[key].includes(null)) return null;
      }
    }
    if (route.endsWith("/promote")) {
      const project = publicProjectBody({ project: value.project }, status);
      if (!project?.project) return null;
      out.project = project.project;
      if (value.warning !== undefined) { if (typeof value.warning !== "string") return null; out.warning = value.warning; }
    }
  }
  if (value.operation !== undefined) { out.operation = publicTaskOperation(value.operation); if (!out.operation) return null; }
  return out;
}
