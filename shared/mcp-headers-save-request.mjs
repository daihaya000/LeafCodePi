import { publicMcpAuthSnapshot } from "./mcp-auth-snapshot.mjs";
import { publicMcpReload } from "./mcp-preset-request.mjs";

/** Private input: validate and clone headers without reflecting values in errors. */
export function parseMcpHeadersSaveRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !["type", "action", "headers"].includes(key))
    || !["type", "action"].some((key) => Object.hasOwn(body, key) && body[key] === "headers")
    || ["type", "action"].some((key) => key in body && (!Object.hasOwn(body, key) || body[key] !== "headers"))
    || !Object.hasOwn(body, "headers") || !body.headers || typeof body.headers !== "object" || Array.isArray(body.headers)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(body.headers))) return { ok: false };
  const entries = Object.entries(body.headers);
  if (!entries.length || entries.length > 32) return { ok: false };
  const seen = new Set();
  const normalized = [];
  for (const [rawName, rawValue] of entries) {
    if (typeof rawValue !== "string") return { ok: false };
    const name = rawName.trim();
    const value = rawValue.trim();
    if (!name || name.length > 256 || !value || value.length > 8192 || /[\r\n]/.test(name + value)
      || seen.has(name.toLowerCase())) return { ok: false };
    seen.add(name.toLowerCase());
    normalized.push([name, value]);
  }
  const headers = Object.fromEntries(normalized); // Own properties, including prototype-like names.
  try { new Headers(headers); } catch { return { ok: false }; }
  return { ok: true, value: { type: "headers", headers } };
}

/** Public result: no header values, owner paths or provider/reload details. */
export function publicMcpHeadersSaveResult(value) {
  if (!value || typeof value !== "object" || value.ok !== true) return null;
  const auth = publicMcpAuthSnapshot(value.auth);
  const reload = publicMcpReload(value.reload);
  if (!auth || auth.authType !== "headers" || auth.credentialSource !== "secure-store" || !reload) return null;
  return { ok: true, auth, reload };
}
