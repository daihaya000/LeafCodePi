import { publicMcpServerList } from "@shared/mcp-server-list.mjs";
import { listMcpServers } from "@/lib/mcp";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";

/** Read only the owner's fixed configuration; no caller paths, variables or connection attempts. */
export function readMcpServerList() {
  assertConfigurationOwner();
  assertLocalRuntimeAllowed();
  const result = publicMcpServerList(listMcpServers(undefined, { strict: true }));
  if (!result) throw new Error("Invalid MCP server list");
  return result;
}
