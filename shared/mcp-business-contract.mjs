import { publicMcpAuthSnapshot } from "./mcp-auth-snapshot.mjs";
import { publicMcpServerList } from "./mcp-server-list.mjs";
import { publicMcpReload } from "./mcp-preset-request.mjs";
import { publicMcpAuthRemoveResult } from "./mcp-auth-remove-request.mjs";
import { publicMcpOAuthStartResult } from "./mcp-oauth-start-request.mjs";
import { publicMcpOAuthCompleteResult } from "./mcp-oauth-complete-request.mjs";
import { publicTaskOperation } from "./task-collection-contract.mjs";
export const MCP_BUSINESS_ROUTES = Object.freeze({ mcp: ["GET", "POST"], "mcp/[name]": ["PATCH"], "mcp/[name]/auth": ["GET", "POST", "DELETE"] });
export function mcpBusinessTarget(path) {
  if (path === "mcp") return { route: path, params: {} };
  const match = /^mcp\/([^/]+)(\/auth)?$/.exec(path); if (!match) return null;
  try { return { route: match[2] ? "mcp/[name]/auth" : "mcp/[name]", params: { name: decodeURIComponent(match[1]).trim() } }; } catch { return null; }
}
export function validMcpBusinessName(name) { return typeof name === "string" && name.length > 0 && name.length <= 256 && name.trim() === name && !/[\x00-\x1f\x7f/\\]/.test(name) && !name.includes(".."); }
export function mcpBusinessBodyLimit(path, method) { return mcpBusinessTarget(path)?.route === "mcp/[name]/auth" && method === "POST" ? 2 * 1024 * 1024 : method === "POST" ? 64 * 1024 : 4096; }
export function publicMcpBusinessBody(route, value, status, method) {
  const target = mcpBusinessTarget(route);
  if (!target || !value || typeof value !== "object" || Array.isArray(value)) return null;
  let out = {};
  if (value.error !== undefined) { if (typeof value.error !== "string") return null; out.error = value.error; }
  if (status < 400) {
    if (out.error !== undefined) return null;
    if (target.route === "mcp" && method === "GET") out = publicMcpServerList(value);
    else if (target.route === "mcp") {
      const list = publicMcpServerList({ servers: value.servers }), reload = publicMcpReload(value.reload);
      if (value.ok !== true || !["n8n", "slack", "google-workspace", "notion"].includes(value.name) || !list || !reload) return null;
      out = { ok: true, name: value.name, servers: list.servers, reload };
    } else if (target.route === "mcp/[name]") {
      const list = publicMcpServerList({ servers: value.servers });
      if (value.ok !== true || !validMcpBusinessName(value.name) || typeof value.enabled !== "boolean" || !list) return null;
      out = { ok: true, name: value.name, enabled: value.enabled, servers: list.servers };
    } else if (method === "GET") out = publicMcpAuthSnapshot(value);
    else if (method === "POST" && Object.hasOwn(value, "name")) out = publicMcpOAuthStartResult(value);
    else if (method === "POST" && Object.hasOwn(value, "status")) out = publicMcpOAuthCompleteResult(value);
    else out = publicMcpAuthRemoveResult(value);
    if (!out) return null;
  }
  if (value.operation !== undefined) { const operation = publicTaskOperation(value.operation); if (!operation) return null; out.operation = operation; }
  return out;
}
