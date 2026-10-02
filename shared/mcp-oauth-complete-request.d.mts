import type { McpPublicAuthSnapshot } from "./mcp-auth-snapshot.mjs";
import type { McpPublicReload } from "./mcp-preset-request.mjs";
export type McpOAuthCompleteRequest = { type: "oauth"; action: "complete"; input: string };
export type McpOAuthCompleteStatus = "authenticated" | "expired" | "not_authenticated";
export type McpOAuthCompleteResult = { ok: true; status: McpOAuthCompleteStatus; auth: McpPublicAuthSnapshot; reload: McpPublicReload };
export function parseMcpOAuthCompleteRequest(body: unknown): { ok: false } | { ok: true; value: McpOAuthCompleteRequest };
export function publicMcpOAuthCompleteResult(value: unknown): McpOAuthCompleteResult | null;
