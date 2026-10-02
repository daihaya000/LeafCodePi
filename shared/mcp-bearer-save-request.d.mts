import type { McpPublicAuthSnapshot } from "./mcp-auth-snapshot.mjs";
import type { McpPublicReload } from "./mcp-preset-request.mjs";
/** Private request: never include this value in a public response or log. */
export type McpBearerSaveRequest = { type: "bearer"; token: string };
export type McpBearerSaveResult = { ok: true; auth: McpPublicAuthSnapshot; reload: McpPublicReload };
export function parseMcpBearerSaveRequest(body: unknown): { ok: false } | { ok: true; value: McpBearerSaveRequest };
export function publicMcpBearerSaveResult(value: unknown): McpBearerSaveResult | null;
