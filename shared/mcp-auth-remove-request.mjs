export { publicMcpBearerRemoveResult as publicMcpAuthRemoveResult } from "./mcp-bearer-remove-request.mjs";

/** Empty requests defer method selection to the owner; OAuth is not migrated yet. */
export function parseMcpAuthRemoveRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(body))
    || Object.keys(body).some((key) => !["type", "action"].includes(key))
    || ["type", "action"].some((key) => key in body && (!Object.hasOwn(body, key) || !["bearer", "headers"].includes(body[key])))
    || (Object.hasOwn(body, "type") && Object.hasOwn(body, "action") && body.type !== body.action)) return { ok: false };
  const type = body.type ?? body.action;
  return { ok: true, value: type ? { type } : {} };
}
