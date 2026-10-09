import { publicTaskOperation } from "./task-collection-contract.mjs";
/** Pure Bot lifecycle transport and deeply projected operator-facing configuration. */
export const BOT_LIFECYCLE_ROUTES = Object.freeze({ bots: ["GET", "POST"], "bots/[id]": ["GET", "PATCH", "DELETE"] });
export function validBotLifecycleId(id) { return typeof id === "string" && id.length <= 128 && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id); }
export function botLifecycleTarget(path) {
  if (Object.hasOwn(BOT_LIFECYCLE_ROUTES, path)) return { route: path, params: {} };
  const match = /^bots\/([^/]+)$/.exec(path); if (!match) return null;
  // Reserved siblings are separate, unmigrated APIs, never individual Bot selectors.
  if (["sidebar", "events", "rooms"].includes(match[1])) return null;
  try { return { route: "bots/[id]", params: { id: decodeURIComponent(match[1]) } }; } catch { return null; }
}
export function botLifecycleBodyLimit(path, method) { return method === "PATCH" ? 4 * 1024 * 1024 : 4096; }
const record = value => value && typeof value === "object" && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");
export function publicBot(value) {
  if (!record(value)) return null;
  const out = {};
  for (const key of ["id", "name", "label", "avatarColor", "createdAt", "updatedAt", "soul"]) { if (typeof value[key] !== "string") return null; out[key] = value[key]; }
  for (const key of ["avatarImage", "model"]) { if (value[key] !== null && typeof value[key] !== "string") return null; out[key] = value[key]; }
  if (value.thinkingLevel !== null && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinkingLevel)) return null;
  if (value.permissionMode !== null && !["allow", "ask", "deny"].includes(value.permissionMode)) return null;
  out.thinkingLevel = value.thinkingLevel; out.permissionMode = value.permissionMode;
  for (const key of ["enabled", "notificationsEnabled", "codeAutoApprove"]) { if (typeof value[key] !== "boolean") return null; out[key] = value[key]; }
  const skills = value.skills;
  if (!record(skills) || !["inherit", "include", "exclude"].includes(skills.mode) || !strings(skills.include) || !strings(skills.exclude) || !strings(value.extraRoots)) return null;
  out.skills = { mode: skills.mode, include: [...skills.include], exclude: [...skills.exclude] }; out.extraRoots = [...value.extraRoots];
  if (value.tools !== undefined) { if (!strings(value.tools)) return null; out.tools = [...value.tools]; }
  for (const key of ["avatarShape", "avatarEyeColor", "intercomScopeId"]) if (value[key] !== undefined) { if (typeof value[key] !== "string") return null; out[key] = value[key]; }
  for (const key of ["ttsVoice", "codeSessionTaskId"]) if (value[key] !== undefined) { if (value[key] !== null && typeof value[key] !== "string") return null; out[key] = value[key]; }
  for (const key of ["avatarGlasses", "avatarMustache", "intercomEnabled", "intercomFanoutEnabled"]) if (value[key] !== undefined) { if (typeof value[key] !== "boolean") return null; out[key] = value[key]; }
  if (value.codeSessionCount !== undefined) { if (!Number.isInteger(value.codeSessionCount) || value.codeSessionCount < 0) return null; out.codeSessionCount = value.codeSessionCount; }
  return out;
}
export function publicBotLifecycleBody(route, value, status, method) {
  if (!Object.hasOwn(BOT_LIFECYCLE_ROUTES, route) || !record(value)) return null;
  const out = {};
  if (value.error !== undefined) { if (typeof value.error !== "string") return null; out.error = value.error; }
  if (status < 400) {
    if (out.error !== undefined) return null;
    if (method === "DELETE") { if (value.ok !== true) return null; out.ok = true; }
    else if (route === "bots" && method === "GET") { if (!Array.isArray(value.bots)) return null; out.bots = value.bots.map(publicBot); if (out.bots.some(bot => bot === null)) return null; }
    else { out.bot = publicBot(value.bot); if (!out.bot) return null; }
  }
  if (value.operation !== undefined && method !== "GET") { out.operation = publicTaskOperation(value.operation); if (!out.operation) return null; }
  return out;
}
