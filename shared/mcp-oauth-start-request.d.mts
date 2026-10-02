export type McpOAuthStartRequest = { type: "oauth"; action: "start" };
export type McpOAuthStartResult =
  | { ok: true; name: string; status: "pending"; authorizationUrl: string }
  | { ok: true; name: string; status: "authenticated" };
export function parseMcpOAuthStartRequest(body: unknown): { ok: false } | { ok: true; value: McpOAuthStartRequest };
export function publicMcpOAuthStartResult(value: unknown): McpOAuthStartResult | null;
