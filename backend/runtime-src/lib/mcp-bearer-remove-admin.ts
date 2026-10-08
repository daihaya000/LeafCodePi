import { parseMcpBearerRemoveRequest, publicMcpBearerRemoveResult, type McpBearerRemoveRequest } from "@shared/mcp-bearer-remove-request.mjs";
import { disableMcpBearerStore, getMcpServerAuth, listMcpServers, McpError } from "@/lib/mcp";
import { readMcpAuthStatus } from "@/lib/mcp-auth-status";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { requestMcpWebUiAuth } from "@/lib/pi/mcp-webui-bridge";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";

/** Owner-only removal; the credential bridge is temporary until native MCP replacement. */
export async function removeMcpBearerAuth(name: string, input: McpBearerRemoveRequest = {}) {
  assertLocalRuntimeAllowed();
  const parsed = parseMcpBearerRemoveRequest(input);
  if (!parsed.ok) throw new McpError("invalid-auth", "Bearer認証削除リクエストが不正です");
  const current = getMcpServerAuth(name);
  // Legacy lookup can see inherited properties; only actual configured entries may remove credentials.
  if (!listMcpServers().servers.some((server) => server.name === current.name)) {
    throw new McpError("not-found", "MCP サーバーが見つかりません");
  }
  if (!parsed.value.type && current.authType !== "bearer" && current.authType !== "none") {
    throw new McpError("invalid-auth", "この認証方式の削除は未移管です");
  }
  try {
    const response = await requestMcpWebUiAuth({ operation: "bearer-remove", serverName: current.name });
    if (response?.ok !== true || response.operation !== "bearer-remove") throw new Error("Store refused");
  } catch {
    throw new McpError("auth-unavailable", "Bearer認証情報を削除できませんでした");
  }
  // Preserve existing ordering. A later config/reload failure does not imply store rollback.
  disableMcpBearerStore(current.name);
  const reload = await reloadLiveSessionsContext();
  const result = publicMcpBearerRemoveResult({ ok: true, auth: await readMcpAuthStatus(current.name), reload });
  if (!result) throw new Error("Invalid MCP bearer removal result");
  return result;
}
