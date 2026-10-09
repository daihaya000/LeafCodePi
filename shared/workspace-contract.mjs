/** Pure Workspace protocol. Files are the user's selected UTF-8 attachments, not owner/SDK objects. */
export const WORKSPACE_ROUTES = Object.freeze({ "projects/[id]/files": ["GET"], "tasks/[id]/files": ["GET"], "projects/[id]/next-task": ["POST"] });
export const WORKSPACE_BODY_LIMIT = 80_000 * 4;
export function workspaceTarget(path) {
  if (Object.hasOwn(WORKSPACE_ROUTES, path)) return { route: path, params: {} };
  const match = /^(projects|tasks)\/([^/]+)\/(files|next-task)$/.exec(path);
  if (!match || (match[1] === "tasks" && match[3] !== "files")) return null;
  try { return { route: `${match[1]}/[id]/${match[3]}`, params: { id: decodeURIComponent(match[2]) } }; } catch { return null; }
}
const record = value => value && typeof value === "object" && !Array.isArray(value);
const string = value => typeof value === "string";
const count = value => Number.isSafeInteger(value) && value >= 0;
export function publicWorkspaceBody(route, input, status) {
  if (!Object.hasOwn(WORKSPACE_ROUTES, route) || !record(input)) return null;
  if (status >= 400) return string(input.error) ? { error: input.error } : null;
  if (route.endsWith("/next-task")) {
    if (!string(input.suggestion) || !Array.isArray(input.suggestions) || !input.suggestions.every(string) || input.source !== "direct" || !record(input.model) || !string(input.model.providerID) || !string(input.model.modelID)) return null;
    const model = { providerID: input.model.providerID, modelID: input.model.modelID };
    if (input.model.accountId !== undefined) { if (!string(input.model.accountId)) return null; model.accountId = input.model.accountId; }
    return { suggestion: input.suggestion, suggestions: input.suggestions, source: "direct", model };
  }
  if (input.entries !== undefined) {
    if (!string(input.path) || !(input.parent === null || string(input.parent)) || typeof input.truncated !== "boolean" || !Array.isArray(input.entries) || input.entries.length > 1000) return null;
    const entries = [];
    for (const row of input.entries) {
      if (!record(row) || !string(row.name) || !string(row.path) || !["dir", "file"].includes(row.kind) || (row.size !== undefined && !count(row.size))) return null;
      entries.push({ name: row.name, path: row.path, kind: row.kind, ...(row.size === undefined ? {} : { size: row.size }) });
    }
    return { path: input.path, parent: input.parent, entries, truncated: input.truncated };
  }
  if (!string(input.name) || input.mimeType !== "text/plain" || !count(input.size) || input.size < 1 || input.size > 65536 || !string(input.data) || input.data.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) return null;
  const bytes = input.data.length / 4 * 3 - (input.data.endsWith("==") ? 2 : input.data.endsWith("=") ? 1 : 0);
  return bytes === input.size ? { name: input.name, mimeType: "text/plain", size: input.size, data: input.data } : null;
}
