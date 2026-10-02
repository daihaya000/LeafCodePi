import { publicMcpServerList } from "@shared/mcp-server-list.mjs";
import { listMcpServers } from "@/lib/mcp";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";

/** Read only the owner's fixed configuration; no caller paths, variables or connection attempts. */
export function readMcpServerList() {
  assertLocalRuntimeAllowed();
  const result = publicMcpServerList(listMcpServers(undefined, { strict: true }));
  if (!result) throw new Error("Invalid MCP server list");
  return result;
}
