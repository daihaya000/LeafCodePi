import { markMcpBusinessEffect } from "@backend-core/mcp-business-effects.mjs";
import { parseMcpBearerSaveRequest, publicMcpBearerSaveResult, type McpBearerSaveRequest } from "@shared/mcp-bearer-save-request.mjs";
import { enableMcpBearerStore, getMcpServerAuth, McpError, resolveMcpServerUrl } from "@/lib/mcp";
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
    throw new McpError("auth-unavailable", "Bearer認証情報を更新できませんでした");
  }
}

/** Owner-only save. The legacy store bridge is temporary and never called from production WebUI. */
export async function saveMcpBearerAuth(name: string, input: McpBearerSaveRequest) {
  assertConfigurationOwner();
  assertLocalRuntimeAllowed();
  const parsed = parseMcpBearerSaveRequest(input);
  if (!parsed.ok) throw new McpError("invalid-auth", "Bearer認証リクエストが不正です");
  const current = getMcpServerAuth(name);
  resolveMcpServerUrl(current.name); // Validate the owner's HTTP endpoint before any store change.
  // Preserve existing store-switch ordering. Cross-store/config rollback is not implied:
  // if a later operation fails, do not report success or expose a provider exception.
  await callStore({ operation: "bearer-save", serverName: current.name, token: parsed.value.token });
  if (current.authType === "headers" && current.credentialSource === "secure-store") {
    await callStore({ operation: "headers-remove", serverName: current.name });
  }
  enableMcpBearerStore(current.name);
  const reload = await reloadLiveSessionsContext();
  const result = publicMcpBearerSaveResult({ ok: true, auth: await readMcpAuthStatus(current.name), reload });
  if (!result) throw new Error("Invalid MCP bearer save result");
  return result;
}
