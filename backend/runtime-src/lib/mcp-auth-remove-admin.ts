import { markMcpBusinessEffect } from "@backend-core/mcp-business-effects.mjs";
import { parseMcpAuthRemoveRequest, publicMcpAuthRemoveResult, type McpAuthRemoveRequest } from "@shared/mcp-auth-remove-request.mjs";
import { disableMcpHeadersStore, getMcpServerAuth, listMcpServers, McpError } from "@/lib/mcp";
import { removeMcpBearerAuth } from "@/lib/mcp-bearer-remove-admin";
import { readMcpAuthStatus } from "@/lib/mcp-auth-status";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { requestMcpWebUiAuth } from "@/lib/pi/mcp-webui-bridge";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";

/** Owner-resolved deletion. The legacy credential bridge is temporary. */
export async function removeMcpAuth(name: string, input: McpAuthRemoveRequest = {}) {
  assertConfigurationOwner();
  assertLocalRuntimeAllowed();
  const parsed = parseMcpAuthRemoveRequest(input);
  if (!parsed.ok) throw new McpError("invalid-auth", "認証削除リクエストが不正です");
  const current = getMcpServerAuth(name);
  if (!listMcpServers().servers.some((server) => server.name === current.name)) {
    throw new McpError("not-found", "MCP サーバーが見つかりません");
  }
  const method = parsed.value.type ?? (current.authType === "none" ? "bearer"
    : current.authType === "auto" ? "oauth" : current.authType);
  if (method === "bearer") return removeMcpBearerAuth(current.name, { type: "bearer" });
  if (method !== "headers" && method !== "oauth") throw new McpError("invalid-auth", "認証方式が不正です");
  const operation = method === "headers" ? "headers-remove" : "oauth-remove";
  try {
    markMcpBusinessEffect();
    const response = await requestMcpWebUiAuth({ operation, serverName: current.name });
    if (response?.ok !== true || response.operation !== operation) throw new Error("Store refused");
  } catch {
    throw new McpError("auth-unavailable", method === "headers"
      ? "HTTPヘッダー認証情報を削除できませんでした" : "OAuth認証情報を解除できませんでした");
  }
  // Store -> optional selector -> reload. Later failures do not imply credential rollback.
  // OAuth removal clears its tokens/pending flow, not the provider configuration or other stores.
  if (method === "headers") disableMcpHeadersStore(current.name);
  const reload = await reloadLiveSessionsContext();
  const result = publicMcpAuthRemoveResult({ ok: true, auth: await readMcpAuthStatus(current.name), reload });
  if (!result) throw new Error("Invalid MCP auth removal result");
  return result;
}
