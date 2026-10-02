import type { McpPublicAuthSnapshot } from "./mcp-auth-snapshot.mjs";
import type { McpPublicReload } from "./mcp-preset-request.mjs";
/** Omitted type means the owner must check that the configured default is bearer. */
export type McpBearerRemoveRequest = { type?: "bearer" };
export type McpBearerRemoveResult = { ok: true; auth: McpPublicAuthSnapshot; reload: McpPublicReload };
export function parseMcpBearerRemoveRequest(body: unknown): { ok: false } | { ok: true; value: McpBearerRemoveRequest };
export function publicMcpBearerRemoveResult(value: unknown): McpBearerRemoveResult | null;
