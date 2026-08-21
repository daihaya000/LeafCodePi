/**
 * Global MCP servers with ON/OFF, managed through Pi's global override file
 * `~/.pi/agent/mcp.json`. pi-mcp-adapter reads this file (highest-precedence
 * Pi layer) plus shared `.mcp.json`/`~/.config/mcp/mcp.json` sources; we only
 * manage the Pi global override so existing shared configs keep working.
 *
 * ON/OFF maps to the per-server `disabled` field (only literal `true` disables).
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolvePiAgentDir } from "@/lib/agents-md";

type McpServer = {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  disabled?: boolean;
  [key: string]: unknown;
};

export type McpDto = {
  id: string;
  name: string;
  enabled: boolean;
  source: "stdio" | "http";
};

export type McpListResult = {
  servers: McpDto[];
  /** Pi global override path. */
  configPath: string;
};

export class McpError extends Error {
  constructor(
    readonly code: "invalid-name" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

export function mcpErrorStatus(error: unknown): number {
  if (error instanceof McpError) {
    return error.code === "invalid-name" ? 400 : 404;
  }
  return 500;
}

export function piMcpConfigPath(agentDir = resolvePiAgentDir()): string {
  return join(agentDir, "mcp.json");
}

type McpConfig = {
  mcpServers: Record<string, McpServer>;
};

function readConfig(path: string): McpConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: unknown };
    const mcpServers = raw?.mcpServers;
    if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
      return { mcpServers: mcpServers as Record<string, McpServer> };
    }
    return { mcpServers: {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[mcp] failed to read config", error);
    }
    return { mcpServers: {} };
  }
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.${Date.now()}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function listMcpServers(agentDir = resolvePiAgentDir()): McpListResult {
  const config = readConfig(piMcpConfigPath(agentDir));
  const servers = Object.entries(config.mcpServers)
    .map(
      ([name, entry]): McpDto => ({
        id: name,
        name,
        enabled: entry?.disabled !== true,
        source: typeof entry?.url === "string" ? "http" : "stdio",
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { servers, configPath: piMcpConfigPath(agentDir) };
}

export function setMcpServerEnabled(
  name: string,
  enabled: boolean,
  agentDir = resolvePiAgentDir(),
): McpListResult {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new McpError("invalid-name", "名前が不正です");
  }
  const config = readConfig(piMcpConfigPath(agentDir));
  const entry = config.mcpServers[trimmed];
  if (!entry) throw new McpError("not-found", "MCP サーバーが見つかりません");

  if (enabled) delete entry.disabled;
  else entry.disabled = true;

  atomicWrite(piMcpConfigPath(agentDir), `${JSON.stringify(config, null, 2)}\n`);
  return listMcpServers(agentDir);
}
