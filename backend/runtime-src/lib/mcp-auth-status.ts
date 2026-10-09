import { publicMcpAuthSnapshot } from "@shared/mcp-auth-snapshot.mjs";
import { getMcpServerAuth } from "@/lib/mcp";
import { requestMcpWebUiAuth, type McpWebUiAuthRequest } from "@/lib/pi/mcp-webui-bridge";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";

/** Read-only owner handler. The temporary legacy bridge is consulted only in this process. */
export async function readMcpAuthStatus(name: string) {
  assertConfigurationOwner();
  assertLocalRuntimeAllowed();
  const snapshot = getMcpServerAuth(name);
  const operation: McpWebUiAuthRequest["operation"] | null = snapshot.authType === "bearer"
    ? snapshot.credentialSource === "secure-store" ? "bearer-status" : null
    : snapshot.authType === "headers"
      ? snapshot.credentialSource === "secure-store" ? "headers-status" : null
      : snapshot.authType === "oauth" || snapshot.authType === "auto" ? "oauth-status" : null;
  let credentialStatus = snapshot.credentialStatus;
  if (operation) {
    credentialStatus = "unavailable";
    try {
      const result = await requestMcpWebUiAuth({ operation, serverName: snapshot.name });
      if (result?.ok && result.operation === operation) {
        if (result.operation === "bearer-status" || result.operation === "headers-status") credentialStatus = result.status;
        else if (result.operation === "oauth-status") credentialStatus = result.status === "authenticated" ? "present"
          : result.status === "expired" ? "expired" : result.status === "not_authenticated" ? "missing" : "unavailable";
      }
    } catch { /* Never expose a keyring/provider exception or message. */ }
  }
  const result = publicMcpAuthSnapshot({ ...snapshot, credentialStatus });
  if (!result) throw new Error("Invalid MCP auth metadata");
  return result;
}
