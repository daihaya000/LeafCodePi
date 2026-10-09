import { publicConfigurationMutation } from "./configuration-contract.mjs";
/** Pure definition routing and public DTOs; never inspect files or interpret mutation inputs. */
export const DEFINITION_ROUTES = Object.freeze({
  agents: ["GET", "POST"], "agents/[name]": ["GET", "PATCH", "DELETE"],
  skills: ["GET", "POST"], "skills/[name]": ["PATCH"],
  extensions: ["GET"], "extensions/[name]": ["PATCH"],
  "agents-md": ["GET", "PATCH"], "bots-md": ["GET", "PATCH"], "soul-md": ["GET", "PATCH"], "user-md": ["GET", "PATCH"],
  "tools-md": ["GET", "PATCH"], "design-md": ["GET", "PATCH"], "workflow-md": ["GET", "PATCH"], "prompts/transfer": ["POST"],
});
export function definitionTarget(path) {
  if (Object.hasOwn(DEFINITION_ROUTES, path) && !path.includes("[")) return { route: path, params: {} };
  const match = /^(agents|skills|extensions)\/([^/]+)$/.exec(path);
  if (!match) return null;
  try { return { route: `${match[1]}/[name]`, params: { name: decodeURIComponent(match[2]) } }; } catch { return null; }
}
export function definitionBodyLimit(route) {
  if (route === "prompts/transfer") return 20 * 1024 * 1024 + 4096;
  // Leave room for a valid 2 MiB Markdown file with JSON escaping.
  return route.endsWith("-md") ? 2 * 1024 * 1024 * 6 + 4096 : 1024 * 1024;
}
const agentFields = ["name", "description", "aliases", "tools", "model", "fallbackModels", "thinking", "systemPromptMode", "inheritProjectContext", "inheritSkills", "async", "systemPrompt"];
const fields = {
  agents: ["agents", "agentsDir", "autoEnabled"], "agents/[name]": ["ok", "agents", "draft", "filePath", ...agentFields],
  skills: ["ok", "names", "enabled", "scope", "skills", "skillsDir", "bundledSkillsDir"],
  "skills/[name]": ["ok", "name", "enabled", "scope", "skills"],
  extensions: ["extensions", "extensionsDir", "bundledExtensionsDir"], "extensions/[name]": ["ok", "name", "enabled", "extensions"],
  "prompts/transfer": ["backup", "imported", "warning"],
};
const record = value => value && typeof value === "object" && !Array.isArray(value);
export function publicDefinitionBody(route, input, status) {
  if (!Object.hasOwn(DEFINITION_ROUTES, route) || !record(input)) return null;
  if (input.error !== undefined && typeof input.error !== "string") return null;
  if (!input.error && status < 400) {
    if (route.endsWith("-md")) { if (typeof input.content !== "string" || typeof input.path !== "string" || typeof input.exists !== "boolean") return null; }
    else if (route === "agents") { if (!Array.isArray(input.agents)) return null; }
    else if (route === "agents/[name]") { if (!Array.isArray(input.agents) && (!record(input.draft) || typeof input.draft.systemPrompt !== "string" || typeof input.filePath !== "string")) return null; }
    else if (route.startsWith("skills")) { if (!Array.isArray(input.skills)) return null; }
    else if (route.startsWith("extensions")) { if (!Array.isArray(input.extensions)) return null; }
    else if (route === "prompts/transfer" && !record(input.backup) && !Array.isArray(input.imported)) return null;
  }
  const body = {};
  for (const name of ["error", ...(fields[route] ?? ["ok", "path", "exists", "content"])]) if (Object.hasOwn(input, name)) body[name] = input[name];
  if (body.draft !== undefined) {
    if (!record(body.draft)) return null;
    const draft = {}; for (const field of agentFields) if (Object.hasOwn(body.draft, field)) draft[field] = body.draft[field];
    body.draft = draft;
  }
  if (input.mutation !== undefined) { const mutation = publicConfigurationMutation(input.mutation); if (!mutation) return null; body.mutation = mutation; }
  if (input.reload !== undefined) {
    if (!record(input.reload) || !["reloaded", "deferred", "failed"].every(key => Number.isInteger(input.reload[key]) && input.reload[key] >= 0)) return null;
    body.reload = { reloaded: input.reload.reloaded, deferred: input.reload.deferred, failed: input.reload.failed, errors: [] };
  }
  return body;
}
