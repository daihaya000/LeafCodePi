import { markMcpBusinessEffect } from "@backend-core/mcp-business-effects.mjs";
import { parseMcpHeadersSaveRequest, publicMcpHeadersSaveResult, type McpHeadersSaveRequest } from "@shared/mcp-headers-save-request.mjs";
import { enableMcpHeadersStore, getMcpServerAuth, McpError, resolveMcpServerUrl } from "@/lib/mcp";
import { readMcpAuthStatus } from "@/lib/mcp-auth-status";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { requestMcpWebUiAuth, type McpWebUiAuthRequest } from "@/lib/pi/mcp-webui-bridge";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";

async function callStore(request: McpWebUiAuthRequest) {
  markMcpBusinessEffect();
  try {
    const result = await requestMcpWebUiAuth(request);
    if (!result?.ok || result.operation !== request.operation) throw new Error("Store refused");
  } catch {
    throw new McpError("auth-unavailable", "HTTPヘッダー認証情報を更新できませんでした");
  }
}

/** Owner-only operation; the legacy credential bridge remains temporary. */
export async function saveMcpHeadersAuth(name: string, input: McpHeadersSaveRequest) {
  assertConfigurationOwner();
  assertLocalRuntimeAllowed();
  const parsed = parseMcpHeadersSaveRequest(input);
  if (!parsed.ok) throw new McpError("invalid-auth", "HTTPヘッダー認証リクエストが不正です");
  const current = getMcpServerAuth(name);
  resolveMcpServerUrl(current.name);
  // Preserve store-switch ordering; cross-store/config changes are not transactional.
  await callStore({ operation: "headers-save", serverName: current.name, headers: parsed.value.headers });
  if (current.authType === "bearer" && current.credentialSource === "secure-store") {
    await callStore({ operation: "bearer-remove", serverName: current.name });
  }
  enableMcpHeadersStore(current.name);
  const reload = await reloadLiveSessionsContext();
  const result = publicMcpHeadersSaveResult({ ok: true, auth: await readMcpAuthStatus(current.name), reload });
  if (!result) throw new Error("Invalid MCP headers save result");
  return result;
}
