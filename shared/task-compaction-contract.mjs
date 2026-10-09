import { publicTaskDetail } from "./task-lifecycle-contract.mjs";
import { publicTaskOperation } from "./task-collection-contract.mjs";
/** Pure manual-compaction protocol; abort ACK is not a promise that a provider has settled. */
export const TASK_COMPACTION_ROUTES = Object.freeze({ "tasks/[id]/compact": ["POST"], "tasks/[id]/compact/abort": ["POST"] });
// 32,000 Unicode code points can require 192,000 JSON bytes when control characters are escaped.
export const TASK_COMPACTION_BODY_LIMIT = 192 * 1024;
export function taskCompactionTarget(path) {
  if (Object.hasOwn(TASK_COMPACTION_ROUTES, path)) return { route: path, params: {} };
  const match = /^tasks\/([^/]+)\/compact(\/abort)?$/.exec(path);
  if (!match) return null;
  try { return { route: `tasks/[id]/compact${match[2] ?? ""}`, params: { id: decodeURIComponent(match[1]) } }; }
  catch { return null; }
}
export function taskCompactionBodyLimit(path) { return taskCompactionTarget(path)?.route.endsWith("/abort") ? 4096 : TASK_COMPACTION_BODY_LIMIT; }
export function taskCompactionTimeout(path) { return taskCompactionTarget(path)?.route.endsWith("/abort") ? 10_000 : 300_000; }
export function publicTaskCompactionBody(route, value, status) {
  if (!Object.hasOwn(TASK_COMPACTION_ROUTES, route) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  if (value.error !== undefined) { if (typeof value.error !== "string") return null; out.error = value.error; }
  if (status < 400) {
    out.task = publicTaskDetail(value.task);
    if (!out.task || out.error !== undefined) return null;
  }
  if (value.operation !== undefined) { out.operation = publicTaskOperation(value.operation); if (!out.operation) return null; }
  return out;
}
