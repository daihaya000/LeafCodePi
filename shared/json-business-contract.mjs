import { DEFINITION_ROUTES, definitionTarget, definitionBodyLimit, publicDefinitionBody } from "./definition-contract.mjs";
import { PROVIDER_ROUTES, providerTarget, publicProviderBody } from "./provider-contract.mjs";
/** Pure wire contract. Owner validation/commands never run in the Web relay. */
export const JSON_BUSINESS_PATH = "/internal/json-business";
export const JSON_BUSINESS_HEADERS = Object.freeze({ origin: "x-leafcode-business-origin", host: "x-leafcode-business-host", authorized: "x-leafcode-business-authorized", operation: "x-leafcode-business-operation" });
export const JSON_BUSINESS_ROUTES = Object.freeze({
  "git/branches": ["GET"], "git/commit": ["POST"], "git/commit-message": ["POST"],
  "git/init": ["POST"], "git/log": ["GET"], "git/merge": ["POST"],
  "git/pr": ["GET", "POST"], "git/pull": ["POST"], "git/push": ["POST"],
  "git/repositories": ["GET"], "git/rm": ["POST"], "git/show": ["GET"], "diff/files": ["GET"],
  ...DEFINITION_ROUTES, ...PROVIDER_ROUTES,
});
export const JSON_BUSINESS_BODY_LIMIT = 1024 * 1024;
export function jsonBusinessTarget(path) {
  if (Object.hasOwn(JSON_BUSINESS_ROUTES, path) && !path.includes("[")) return { route: path, params: {} };
  return definitionTarget(path) ?? providerTarget(path);
}
export function jsonBusinessBodyLimit(path) { const target = definitionTarget(path); return target ? definitionBodyLimit(target.route) : JSON_BUSINESS_BODY_LIMIT; }
export function jsonBusinessCommand(path, method) { return method !== "GET" && Boolean(definitionTarget(path) || providerTarget(path)); }
export const JSON_BUSINESS_RESPONSE_LIMIT = 32 * 1024 * 1024;
export function jsonBusinessTimeout(route) { return route === "git/pr" ? 200_000 : 180_000; }
export function jsonBusinessMutates(route, method) { return method !== "GET" && route !== "git/commit-message"; }
const fields = {
  "git/branches": ["current", "branches", "defaultTarget", "upstream", "ahead", "remotes", "hasRemote"],
  "git/commit": ["ok", "summary", "stdout"], "git/commit-message": ["message", "source", "model", "warning"],
  "git/init": ["ok", "directory"], "git/log": ["commits", "refs", "currentBranch", "hasMore"],
  "git/merge": ["ok", "merged", "into", "summary", "restored", "strandedOn", "mergeSucceeded", "conflict", "worktreeConflict"],
  "git/pr": ["available", "version", "hint", "ok", "url"], "git/pull": ["ok", "summary"], "git/push": ["ok", "summary"],
  "git/repositories": ["repositories"], "git/rm": ["ok", "path"], "git/show": ["commit", "files", "diff"],
  "diff/files": ["git", "branch", "files", "additions", "deletions", "count"],
};
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
/** Schema checks at the public boundary; never forward arbitrary owner headers or top-level fields. */
export function publicJsonBusinessResult(route, value) {
  const target = jsonBusinessTarget(route);
  if (!target) return null;
  route = target.route;
  if (!record(value) || !Number.isInteger(value.status) || value.status < 200 || value.status > 599) return null;
  const headers = {};
  for (const name of ["cache-control", "etag", "x-content-type-options"]) {
    const field = value.headers?.[name];
    if (field !== undefined && (typeof field !== "string" || /[\r\n]/.test(field))) return null;
    if (field !== undefined) headers[name] = field;
  }
  if (value.status === 304) return value.body === null ? { status: 304, headers, body: null } : null;
  if (Object.hasOwn(PROVIDER_ROUTES, route)) {
    const body = publicProviderBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (Object.hasOwn(DEFINITION_ROUTES, route)) {
    const body = publicDefinitionBody(route, value.body, value.status);
    return body ? { status: value.status, headers, body } : null;
  }
  if (!record(value.body)) return null;
  const input = value.body;
  if (input.error !== undefined && typeof input.error !== "string") return null;
  if (!input.error && value.status < 400) {
    switch (route) {
      case "git/branches": if (typeof input.current !== "string" || !Array.isArray(input.branches) || !Array.isArray(input.remotes) || typeof input.ahead !== "number") return null; break;
      case "git/log": if (!Array.isArray(input.commits) || !Array.isArray(input.refs) || typeof input.hasMore !== "boolean") return null; break;
      case "git/show": if (typeof input.commit !== "string" || (!Array.isArray(input.files) && typeof input.diff !== "string")) return null; break;
      case "git/repositories": if (!Array.isArray(input.repositories)) return null; break;
      case "diff/files": if (typeof input.git !== "boolean" || !Array.isArray(input.files) || typeof input.additions !== "number" || typeof input.deletions !== "number") return null; break;
      case "git/commit-message": if (typeof input.message !== "string" || !["direct", "fallback"].includes(input.source)) return null; break;
      case "git/pr": if (typeof input.available !== "boolean" && (input.ok !== true || typeof input.url !== "string")) return null; break;
      default: if (input.ok !== true) return null;
    }
  }
  const body = {};
  for (const name of ["error", ...fields[route]]) if (Object.hasOwn(input, name)) body[name] = input[name];
  if (route === "git/commit-message" && body.model !== undefined && body.model !== null) {
    if (!record(body.model) || typeof body.model.providerID !== "string" || typeof body.model.modelID !== "string") return null;
    const model = { providerID: body.model.providerID, modelID: body.model.modelID };
    if (body.model.accountId !== undefined) { if (typeof body.model.accountId !== "string") return null; model.accountId = body.model.accountId; }
    body.model = model;
  }
  return { status: value.status, headers, body };
}
