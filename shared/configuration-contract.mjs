/** Configuration HTTP surface owned by Backend; no UI, SDK or filesystem imports. */
export const CONFIGURATION_PATH = "/internal/configuration";
export const CONFIGURATION_ROUTES = Object.freeze({
  settings: ["GET"], "settings/[key]": ["GET", "PUT"],
  "settings/hang-timeout": ["GET", "PATCH"], "settings/intercom": ["GET", "PATCH"],
  "settings/llama-server-config": ["GET", "PUT"], "settings/system-safety": ["GET", "PATCH"],
  "settings/tts": ["GET", "PATCH"], "settings/transfer": ["GET", "POST", "DELETE"],
  "cache-warming": ["GET", "PATCH"], "compaction-settings": ["GET", "PATCH"],
  "jev-model": ["GET", "PUT"], "jev-model/legacy-credentials": ["GET", "DELETE"],
  "memory-settings": ["GET", "PUT"], notifications: ["GET", "PUT"], pushover: ["GET", "PUT", "POST"],
  profile: ["POST", "PATCH", "PUT", "DELETE"],
});
export const CONFIGURATION_HEADERS = Object.freeze({
  origin: "x-leafcode-configuration-origin", host: "x-leafcode-configuration-host",
  authorized: "x-leafcode-configuration-authorized", operation: "x-leafcode-configuration-operation",
});
/** Keep the historic archive/transfer ceilings; all other commands are small JSON. */
export function configurationBodyLimit(route, method) {
  if (route === "profile" && method === "POST") return 257 * 1024 * 1024;
  if (route === "settings/transfer") return 20 * 1024 * 1024;
  if (route === "jev-model") return 16_384;
  return 1024 * 1024;
}
export function configurationTarget(path) {
  if (Object.hasOwn(CONFIGURATION_ROUTES, path)) return { route: path, params: {} };
  const match = /^settings\/([^/]+)$/.exec(path);
  if (!match) return null;
  let key;
  try { key = decodeURIComponent(match[1]); } catch { return null; }
  if (!key || key.includes("/") || key.includes("\\") || key.includes("\0")) return null;
  return { route: "settings/[key]", params: { key } };
}
export function publicConfigurationMutation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { operationId, saved, saveStatus, revision, apply, recovery } = value;
  if (typeof operationId !== "string" || !/^[0-9a-f-]{36}$/.test(operationId)) return null;
  if (saved !== true && saved !== false && saved !== null) return null;
  if (!["complete", "partial", "none", "unknown"].includes(saveStatus)) return null;
  if (saved === true && !["complete", "partial"].includes(saveStatus)) return null;
  if (saved === false && saveStatus !== "none") return null;
  if (saved === null && saveStatus !== "unknown") return null;
  if (revision !== null && (typeof revision !== "string" || !/^[0-9a-f-]{36}$/.test(revision))) return null;
  if (saved !== true && revision !== null) return null;
  if (saved === true && revision === null && apply !== "unknown") return null;
  if (!["applied", "deferred", "failed", "not-required", "unknown"].includes(apply)) return null;
  if (!["none", "restored", "required", "unknown"].includes(recovery)) return null;
  return { operationId, saved, saveStatus, revision, apply, recovery };
}
