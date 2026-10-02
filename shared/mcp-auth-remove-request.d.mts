import type { McpBearerRemoveResult } from "./mcp-bearer-remove-request.mjs";
/** Omitted type means the owner selects bearer/headers/OAuth; auto maps to OAuth. */
export type McpAuthRemoveRequest = { type?: "bearer" | "headers" | "oauth" };
export type McpAuthRemoveResult = McpBearerRemoveResult;
export function parseMcpAuthRemoveRequest(body: unknown): { ok: false } | { ok: true; value: McpAuthRemoveRequest };
export function publicMcpAuthRemoveResult(value: unknown): McpAuthRemoveResult | null;
