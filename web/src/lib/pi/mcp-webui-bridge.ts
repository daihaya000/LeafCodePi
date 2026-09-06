export type McpWebUiAuthRequest =
  | { operation: "bearer-status"; serverName: string }
  | { operation: "bearer-save"; serverName: string; token: string }
  | { operation: "bearer-remove"; serverName: string }
  | { operation: "headers-status"; serverName: string }
  | { operation: "headers-save"; serverName: string; headers: Record<string, string> }
  | { operation: "headers-remove"; serverName: string }
  | { operation: "oauth-status"; serverName: string }
  | { operation: "oauth-start"; serverName: string }
  | { operation: "oauth-complete"; serverName: string; input: string }
  | { operation: "oauth-remove"; serverName: string };

export type McpCredentialWebUiAuthResponse =
  | { ok: true; operation: "bearer-status"; status: "present" | "missing" | "url-mismatch" | "unavailable"; message?: string }
  | { ok: true; operation: "bearer-save" | "bearer-remove" | "headers-save" | "headers-remove" }
  | { ok: true; operation: "headers-status"; status: "present" | "missing" | "url-mismatch" | "unavailable"; message?: string }
  | { ok: false; operation: McpWebUiAuthRequest["operation"]; error: string };

export type McpOAuthWebUiAuthResponse =
  | { ok: true; operation: "oauth-status"; status: "authenticated" | "expired" | "not_authenticated" | "unavailable"; message?: string }
  | { ok: true; operation: "oauth-start"; authorizationUrl: string; status: "authenticated" | "pending" }
  | { ok: true; operation: "oauth-complete"; status: "authenticated" | "expired" | "not_authenticated" }
  | { ok: true; operation: "oauth-remove" }
  | { ok: false; operation: McpWebUiAuthRequest["operation"]; error: string };

export type McpWebUiAuthResponse = McpCredentialWebUiAuthResponse | McpOAuthWebUiAuthResponse;
export type McpWebUiAuthHandler = (request: McpWebUiAuthRequest) => Promise<McpWebUiAuthResponse>;

/** Must match extensions/leafcode-mcp-adapter/mcp-webui-bridge.ts. */
const GLOBAL_KEY = "__leafcodeMcpWebUiAuthHandler" as const;
type McpWebUiGlobal = typeof globalThis & {
  [GLOBAL_KEY]?: McpWebUiAuthHandler | null;
};

function globalScope(): McpWebUiGlobal {
  return globalThis as McpWebUiGlobal;
}

/** Registered by the MCP adapter when a live Pi session is available. */
export function registerMcpWebUiAuthHandler(handler: McpWebUiAuthHandler | null): void {
  globalScope()[GLOBAL_KEY] = handler;
}

/** Remove only the handler owned by this adapter instance. */
export function unregisterMcpWebUiAuthHandler(handler: McpWebUiAuthHandler): void {
  if (globalScope()[GLOBAL_KEY] === handler) globalScope()[GLOBAL_KEY] = null;
}

/** Returns null when no live MCP adapter is available. */
export async function requestMcpWebUiAuth(
  request: McpWebUiAuthRequest,
): Promise<McpWebUiAuthResponse | null> {
  const handler = globalScope()[GLOBAL_KEY];
  if (!handler) return null;
  return handler(request);
}
