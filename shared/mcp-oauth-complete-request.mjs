import { publicMcpAuthSnapshot } from "./mcp-auth-snapshot.mjs";
import { publicMcpReload } from "./mcp-preset-request.mjs";

/** Private callback/code input. Never log or echo the normalized value. */
export function parseMcpOAuthCompleteRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(body))
    || Object.keys(body).some((key) => !["type", "action", "input"].includes(key))
    || !Object.hasOwn(body, "type") || body.type !== "oauth"
    || !Object.hasOwn(body, "action") || body.action !== "complete"
    || !Object.hasOwn(body, "input") || typeof body.input !== "string") return { ok: false };
  const input = body.input.trim();
  if (!input || input.length > 16384 || /[\x00-\x1f\x7f]/.test(input)) return { ok: false };
  return { ok: true, value: { type: "oauth", action: "complete", input } };
}

/** Completion may succeed before a subsequent reload fails; expose only safe counters/status. */
export function publicMcpOAuthCompleteResult(value) {
  if (!value || typeof value !== "object" || value.ok !== true
    || !["authenticated", "expired", "not_authenticated"].includes(value.status)) return null;
  const auth = publicMcpAuthSnapshot(value.auth);
  const reload = publicMcpReload(value.reload);
  if (!auth || !["oauth", "auto"].includes(auth.authType) || auth.credentialSource !== "oauth" || !reload) return null;
  return { ok: true, status: value.status, auth, reload };
}
