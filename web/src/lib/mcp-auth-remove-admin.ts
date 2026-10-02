import { parseMcpAuthRemoveRequest, publicMcpAuthRemoveResult, type McpAuthRemoveRequest } from "@shared/mcp-auth-remove-request.mjs";
import { disableMcpHeadersStore, getMcpServerAuth, listMcpServers, McpError } from "@/lib/mcp";
import { removeMcpBearerAuth } from "@/lib/mcp-bearer-remove-admin";
import { readMcpAuthStatus } from "@/lib/mcp-auth-status";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { requestMcpWebUiAuth } from "@/lib/pi/mcp-webui-bridge";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";

/** Owner-resolved deletion. The legacy credential bridge is temporary. */
export async function removeMcpAuth(name: string, input: McpAuthRemoveRequest = {}) {
  assertLocalRuntimeAllowed();
  const parsed = parseMcpAuthRemoveRequest(input);
  if (!parsed.ok) throw new McpError("invalid-auth", "認証削除リクエストが不正です");
  const current = getMcpServerAuth(name);
  if (!listMcpServers().servers.some((server) => server.name === current.name)) {
    throw new McpError("not-found", "MCP サーバーが見つかりません");
  }
  const method = parsed.value.type ?? (current.authType === "none" ? "bearer" : current.authType);
  if (method === "bearer") return removeMcpBearerAuth(current.name, { type: "bearer" });
  if (method !== "headers") throw new McpError("invalid-auth", "この認証方式の削除は未移管です");
  try {
    const response = await requestMcpWebUiAuth({ operation: "headers-remove", serverName: current.name });
    if (response?.ok !== true || response.operation !== "headers-remove") throw new Error("Store refused");
  } catch {
    throw new McpError("auth-unavailable", "HTTPヘッダー認証情報を削除できませんでした");
  }
  // Store -> selector -> reload. Later failures do not imply credential rollback.
  disableMcpHeadersStore(current.name);
  const reload = await reloadLiveSessionsContext();
  const result = publicMcpAuthRemoveResult({ ok: true, auth: await readMcpAuthStatus(current.name), reload });
  if (!result) throw new Error("Invalid MCP auth removal result");
  return result;
}
