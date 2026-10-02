import { publicMcpAuthSnapshot } from "./mcp-auth-snapshot.mjs";
import { publicMcpReload } from "./mcp-preset-request.mjs";

/** Empty requests defer method selection to the owner. Never accept credential/path inputs. */
export function parseMcpBearerRemoveRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !["type", "action"].includes(key))
    || ["type", "action"].some((key) => key in body && (!Object.hasOwn(body, key) || body[key] !== "bearer"))) return { ok: false };
  return { ok: true, value: Object.hasOwn(body, "type") || Object.hasOwn(body, "action") ? { type: "bearer" } : {} };
}

/** Removal may reveal an inherited auth mode; publish only redacted metadata/counters. */
export function publicMcpBearerRemoveResult(value) {
  if (!value || typeof value !== "object" || value.ok !== true) return null;
  const auth = publicMcpAuthSnapshot(value.auth);
  const reload = publicMcpReload(value.reload);
  return auth && reload ? { ok: true, auth, reload } : null;
}
