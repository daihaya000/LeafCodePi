import { parseMcpOAuthCompleteRequest, publicMcpOAuthCompleteResult, type McpOAuthCompleteRequest, type McpOAuthCompleteStatus } from "@shared/mcp-oauth-complete-request.mjs";
import { getMcpServerAuth, listMcpServers, McpError, resolveMcpServerUrl } from "@/lib/mcp";
import { readMcpAuthStatus } from "@/lib/mcp-auth-status";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { requestMcpWebUiAuth } from "@/lib/pi/mcp-webui-bridge";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";

/** Owner-only completion against the pending flow retained by that process. */
export async function completeMcpOAuthAuth(name: string, input: McpOAuthCompleteRequest) {
  assertLocalRuntimeAllowed();
  const parsed = parseMcpOAuthCompleteRequest(input);
  if (!parsed.ok) throw new McpError("invalid-auth", "OAuth完了リクエストが不正です");
  const current = getMcpServerAuth(name);
  if (!listMcpServers().servers.some((server) => server.name === current.name)) {
    throw new McpError("not-found", "MCP サーバーが見つかりません");
  }
  resolveMcpServerUrl(current.name);
  if (current.authType !== "oauth" && current.authType !== "auto") {
    throw new McpError("invalid-auth", "このMCPサーバーではOAuth認証を完了できません");
  }
  let status: McpOAuthCompleteStatus;
  try {
    const response = await requestMcpWebUiAuth({ operation: "oauth-complete", serverName: current.name, input: parsed.value.input });
    if (response?.ok !== true || response.operation !== "oauth-complete"
      || !["authenticated", "expired", "not_authenticated"].includes(response.status)) throw new Error("OAuth owner refused");
    status = response.status;
  } catch {
    throw new McpError("auth-unavailable", "OAuth認証を完了できませんでした。期限切れの場合は認証開始からやり直してください");
  }
  // Completion can consume the pending flow/store tokens before a later reload fails. No rollback is implied.
  const reload = await reloadLiveSessionsContext();
  const result = publicMcpOAuthCompleteResult({ ok: true, status, auth: await readMcpAuthStatus(current.name), reload });
  if (!result) throw new Error("Invalid OAuth completion result");
  return result;
}
