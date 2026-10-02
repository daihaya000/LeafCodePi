import type { McpPublicAuthSnapshot } from "./mcp-auth-snapshot.mjs";
export type McpPublicServer = Omit<McpPublicAuthSnapshot, "configPath"> & {
  id: string;
  enabled: boolean;
  bundled: boolean;
  userConfigured: boolean;
  source: "stdio" | "http";
};
export type McpPublicServerList = { servers: McpPublicServer[]; configPath: ""; bundledConfigPath: null };
export function publicMcpServerList(value: unknown): McpPublicServerList | null;
