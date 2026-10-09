/** Pure Project lifecycle protocol; command completion does not imply atomic persistence/teardown. */
export const PROJECT_ROUTES = Object.freeze({ projects: ["GET", "POST", "PATCH", "DELETE"] });
export const PROJECT_BODY_LIMIT = 4 * 1024 * 1024;
export function projectTarget(path) { return path === "projects" ? { route: path, params: {} } : null; }
const record = value => value && typeof value === "object" && !Array.isArray(value);
export function publicProjectOperation(value) {
  return record(value) && typeof value.id === "string" && /^[0-9a-f-]{36}$/.test(value.id) && ["not-started", "unknown", "complete"].includes(value.execution) ? { id: value.id, execution: value.execution } : null;
}
function project(value) {
  if (!record(value) || !["id", "name", "rootPath"].every(key => typeof value[key] === "string")) return null;
  const result = { id: value.id, name: value.name, rootPath: value.rootPath };
  for (const key of ["favorite", "archived"]) if (value[key] !== undefined) { if (typeof value[key] !== "boolean") return null; result[key] = value[key]; }
  if (value.createdAt !== undefined) { if (typeof value.createdAt !== "string") return null; result.createdAt = value.createdAt; }
  for (const key of ["lastOpenedAt", "icon", "iconColor"]) if (value[key] !== undefined) { if (!(value[key] === null || typeof value[key] === "string")) return null; result[key] = value[key]; }
  return result;
}
export function publicProjectBody(input, status) {
  if (!record(input)) return null;
  const body = {};
  if (input.error !== undefined) { if (typeof input.error !== "string") return null; body.error = input.error; }
  if (status < 400 && input.error === undefined) {
    if (input.projects !== undefined) { if (!Array.isArray(input.projects)) return null; const projects = input.projects.map(project); if (projects.includes(null)) return null; body.projects = projects; }
    else if (input.project !== undefined) { const value = project(input.project); if (!value) return null; body.project = value; }
    else if (input.ok === true) body.ok = true;
    else return null;
    if (input.warning !== undefined) { if (typeof input.warning !== "string") return null; body.warning = input.warning; }
  }
  if (input.operation !== undefined) { const operation = publicProjectOperation(input.operation); if (!operation) return null; body.operation = operation; }
  return body;
}
