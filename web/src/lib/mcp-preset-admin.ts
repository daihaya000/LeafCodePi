import { publicMcpReload, type McpPresetRequest } from "@shared/mcp-preset-request.mjs";
import { addGoogleWorkspaceServers, addN8nServer, addNotionServer, addSlackServer, listMcpServers } from "@/lib/mcp";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";

/** Owner-only operation: production WebUI forwards instead of invoking this handler. */
export async function createMcpPreset(input: McpPresetRequest) {
  assertLocalRuntimeAllowed();
  switch (input.preset) {
    case "n8n": addN8nServer(input.url); break;
    case "slack": addSlackServer(input.clientId); break;
    case "google-workspace": addGoogleWorkspaceServers(input.clientId, input.clientSecret); break;
    case "notion": addNotionServer(); break;
  }
  const reload = publicMcpReload(await reloadLiveSessionsContext());
  if (!reload) throw new Error("Invalid MCP reload result");
  return { ok: true as const, name: input.preset, servers: listMcpServers().servers, reload };
}
