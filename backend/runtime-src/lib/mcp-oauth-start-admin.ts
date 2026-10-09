import { markMcpBusinessEffect } from "@backend-core/mcp-business-effects.mjs";
import { parseMcpOAuthStartRequest, publicMcpOAuthStartResult, type McpOAuthStartRequest } from "@shared/mcp-oauth-start-request.mjs";
import { getMcpServerAuth, listMcpServers, McpError, resolveMcpServerUrl } from "@/lib/mcp";
import { requestMcpWebUiAuth } from "@/lib/pi/mcp-webui-bridge";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";

/** Owner-only OAuth flow creation; the credential bridge is temporary until native MCP replacement. */
export async function startMcpOAuthAuth(name: string, input: McpOAuthStartRequest) {
  assertConfigurationOwner();
  assertLocalRuntimeAllowed();
  if (!parseMcpOAuthStartRequest(input).ok) throw new McpError("invalid-auth", "OAuth開始リクエストが不正です");
  const current = getMcpServerAuth(name);
  if (!listMcpServers().servers.some((server) => server.name === current.name)) {
    throw new McpError("not-found", "MCP サーバーが見つかりません");
  }
  resolveMcpServerUrl(current.name);
  if (current.authType !== "oauth" && current.authType !== "auto") {
    throw new McpError("invalid-auth", "このMCPサーバーではOAuth認証を開始できません");
  }
  try {
    markMcpBusinessEffect();
    const response = await requestMcpWebUiAuth({ operation: "oauth-start", serverName: current.name });
    if (response?.ok !== true || response.operation !== "oauth-start") throw new Error("OAuth owner refused");
    const result = publicMcpOAuthStartResult({ ...response, name: current.name });
    if (!result) throw new Error("Invalid OAuth start response");
    // The owner bridge keeps its callback waiter/pending state; no session reload or config mutation here.
    return result;
  } catch {
    throw new McpError("auth-unavailable", "OAuth認証を開始できませんでした");
  }
}
