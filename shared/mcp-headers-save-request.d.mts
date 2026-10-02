import type { McpPublicAuthSnapshot } from "./mcp-auth-snapshot.mjs";
import type { McpPublicReload } from "./mcp-preset-request.mjs";
/** Private request: never log or return header values. */
export type McpHeadersSaveRequest = { type: "headers"; headers: Record<string, string> };
export type McpHeadersSaveResult = { ok: true; auth: McpPublicAuthSnapshot; reload: McpPublicReload };
export function parseMcpHeadersSaveRequest(body: unknown): { ok: false } | { ok: true; value: McpHeadersSaveRequest };
export function publicMcpHeadersSaveResult(value: unknown): McpHeadersSaveResult | null;
