import { publicTaskOperation } from "./task-collection-contract.mjs";
/** Wire data only; cookies, console paths and owner caches never reach the browser. */
export const TYPESAFE_SETTINGS_ROUTES = Object.freeze({ "typesafe-cookie": ["GET", "POST", "DELETE"], "typesafe-baseline": ["GET", "POST", "DELETE"] });
export function typesafeSettingsTarget(path) { return Object.hasOwn(TYPESAFE_SETTINGS_ROUTES, path) ? { route: path, params: {} } : null; }
// One million UTF-16 cookie characters can expand to six million JSON-escaped bytes.
export function typesafeSettingsBodyLimit(path, method) { return path === "typesafe-cookie" && method === "POST" ? 8 * 1024 * 1024 : 4096; }
export function publicTypesafeSettingsBody(route, value, status, method) {
  if (!Object.hasOwn(TYPESAFE_SETTINGS_ROUTES, route) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  if (value.error !== undefined) { if (typeof value.error !== "string") return null; out.error = value.error; }
  if (status < 400) {
    if (out.error !== undefined) return null;
    if (method !== "GET") { if (value.ok !== true) return null; out.ok = true; }
    if (route === "typesafe-cookie") {
      if (typeof value.configured !== "boolean" || (method === "POST" && !value.configured) || (method === "DELETE" && value.configured)) return null;
      out.configured = value.configured;
    } else {
      if (value.baselineUsd !== null && !(typeof value.baselineUsd === "number" && Number.isFinite(value.baselineUsd) && value.baselineUsd > 0)) return null;
      if ((method === "POST" && (value.baselineUsd === null || value.baselineUsd > 1_000_000)) || (method === "DELETE" && value.baselineUsd !== null)) return null;
      out.baselineUsd = value.baselineUsd;
    }
  }
  if (value.operation !== undefined) { out.operation = publicTaskOperation(value.operation); if (!out.operation) return null; }
  return out;
}
