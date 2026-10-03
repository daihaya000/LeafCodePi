import { publicMcpAuthSnapshot } from "./mcp-auth-snapshot.mjs";
import { publicMcpReload } from "./mcp-preset-request.mjs";

/** Private input: accept only bearer save fields; never log or echo the returned token. */
export function parseMcpBearerSaveRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !["type", "action", "token"].includes(key))
    || !Object.hasOwn(body, "token") || typeof body.token !== "string"
    || ["type", "action"].some((key) => key in body && (!Object.hasOwn(body, key) || body[key] !== "bearer"))) return { ok: false };
  const token = body.token.trim();
  if (!token || token.length > 8192 || /[\r\n]/.test(token)) return { ok: false };
  return { ok: true, value: { type: "bearer", token } };
}

/** Public response: credentials and arbitrary messages/fields never escape. */
export function publicMcpBearerSaveResult(value) {
  if (!value || typeof value !== "object" || value.ok !== true) return null;
  const auth = publicMcpAuthSnapshot(value.auth);
  const reload = publicMcpReload(value.reload);
  // The credential may live in the legacy OS store or (native MCP) in the private config headers.
  if (!auth || auth.authType !== "bearer" || !["secure-store", "config"].includes(auth.credentialSource) || !reload) return null;
  return { ok: true, auth, reload };
}
