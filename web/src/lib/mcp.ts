/**
 * Global MCP servers with ON/OFF and credential metadata, managed through
 * Pi's global override file `~/.pi/agent/mcp.json`. The adapter also reads
 * shared project/global MCP sources; this module writes only the Pi override.
 *
 * Secret values are never returned by this module. Bearer credentials and
 * custom headers entered in the WebUI are stored by the MCP adapter in the OS
 * credential store; the config file only receives non-secret store switches.
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
  headers?: Record<string, unknown>;
  headersStore?: true;
  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  bearerTokenStore?: true;
  oauth?: Record<string, unknown> | false;
  disabled?: boolean;
  [key: string]: unknown;
};

export type McpAuthType = "none" | "bearer" | "oauth" | "headers" | "auto";
export type McpCredentialSource =
  | "none"
  | "config"
  | "environment"
  | "secure-store"
  | "oauth"
  | "headers";
export type McpCredentialStatus =
  | "present"
  | "missing"
  | "expired"
  | "unknown"
  | "unavailable"
  | "url-mismatch";

export type McpDto = {
  id: string;
  name: string;
  enabled: boolean;
  source: "stdio" | "http";
  /** A redacted endpoint suitable for display. */
  url?: string;
  authType: McpAuthType;
  credentialConfigured: boolean;
  credentialSource: McpCredentialSource;
  credentialStatus: McpCredentialStatus;
};

export type McpAuthSnapshot = {
  name: string;
  configPath: string;
  url?: string;
  authType: McpAuthType;
  credentialConfigured: boolean;
  credentialSource: McpCredentialSource;
  credentialStatus: McpCredentialStatus;
  credentialMessage?: string;
};

export type McpListResult = {
  servers: McpDto[];
  /** Pi global override path. */
  configPath: string;
};

export class McpError extends Error {
  constructor(
    readonly code: "invalid-name" | "not-found" | "invalid-auth" | "auth-unavailable",
    message: string,
  ) {
    super(message);
  }
}

export function mcpErrorStatus(error: unknown): number {
  if (error instanceof McpError) {
    if (error.code === "invalid-name" || error.code === "invalid-auth") return 400;
    if (error.code === "not-found") return 404;
    if (error.code === "auth-unavailable") return 503;
  }
  return 500;
}

export function piMcpConfigPath(agentDir = resolvePiAgentDir()): string {
  return join(agentDir, "mcp.json");
}

type McpConfig = {
  mcpServers: Record<string, McpServer>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpServer(value: unknown): value is McpServer {
  return isRecord(value);
}

function readConfig(path: string): McpConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: unknown };
    const mcpServers = raw?.mcpServers;
    if (isRecord(mcpServers)) {
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

function validServerName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new McpError("invalid-name", "名前が不正です");
  }
  return trimmed;
}

function readServer(name: string, agentDir: string): {
  name: string;
  path: string;
  config: McpConfig;
  entry: McpServer;
} {
  const trimmed = validServerName(name);
  const path = piMcpConfigPath(agentDir);
  const config = readConfig(path);
  const candidate = config.mcpServers[trimmed];
  if (!isMcpServer(candidate)) throw new McpError("not-found", "MCP サーバーが見つかりません");
  return { name: trimmed, path, config, entry: candidate };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasHeaders(entry: McpServer): boolean {
  return isRecord(entry.headers) && Object.keys(entry.headers).length > 0;
}

function authTypeFor(entry: McpServer): McpAuthType {
  if (entry.headersStore === true && entry.auth !== "bearer") return "headers";
  if (entry.auth === false) return "none";
  if (
    entry.auth === "bearer" ||
    nonEmptyString(entry.bearerToken) !== undefined ||
    nonEmptyString(entry.bearerTokenEnv) !== undefined ||
    entry.bearerTokenStore === true
  ) {
    return "bearer";
  }
  if (entry.oauth === false) return "none";
  if (entry.auth === "oauth" || isRecord(entry.oauth)) return "oauth";
  if (hasHeaders(entry)) return "headers";
  return typeof entry.url === "string" ? "auto" : "none";
}

function authMetadata(entry: McpServer): Pick<
  McpDto,
  "authType" | "credentialConfigured" | "credentialSource" | "credentialStatus"
> {
  const authType = authTypeFor(entry);
  if (authType === "bearer") {
    if (entry.bearerTokenStore === true) {
      return {
        authType,
        credentialConfigured: true,
        credentialSource: "secure-store",
        credentialStatus: "unknown",
      };
    }
    if (entry.bearerTokenEnv) {
      const configured = typeof entry.bearerTokenEnv === "string" && Boolean(process.env[entry.bearerTokenEnv]);
      return {
        authType,
        credentialConfigured: configured,
        credentialSource: "environment",
        credentialStatus: configured ? "present" : "missing",
      };
    }
    const configured = Boolean(nonEmptyString(entry.bearerToken));
    return {
      authType,
      credentialConfigured: configured,
      credentialSource: configured ? "config" : "none",
      credentialStatus: configured ? "present" : "missing",
    };
  }
  if (authType === "oauth" || authType === "auto") {
    return {
      authType,
      credentialConfigured: false,
      credentialSource: "oauth",
      credentialStatus: "unknown",
    };
  }
  if (authType === "headers") {
    const secureStore = entry.headersStore === true;
    return {
      authType,
      credentialConfigured: true,
      credentialSource: secureStore ? "secure-store" : "headers",
      credentialStatus: secureStore ? "unknown" : "present",
    };
  }
  return {
    authType,
    credentialConfigured: false,
    credentialSource: "none",
    credentialStatus: "missing",
  };
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value
      .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1…@")
      .replace(/([?&](?:token|key|secret|password)=)[^&\s]*/gi, "$1…");
  }
}

function dtoFor(name: string, entry: McpServer): McpDto {
  const metadata = authMetadata(entry);
  return {
    id: name,
    name,
    enabled: entry.disabled !== true,
    source: typeof entry.url === "string" ? "http" : "stdio",
    ...(typeof entry.url === "string" ? { url: redactUrl(entry.url) } : {}),
    ...metadata,
  };
}

export function listMcpServers(agentDir = resolvePiAgentDir()): McpListResult {
  const config = readConfig(piMcpConfigPath(agentDir));
  const servers = Object.entries(config.mcpServers)
    .filter(([, entry]) => isMcpServer(entry))
    .map(([name, entry]) => dtoFor(name, entry))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { servers, configPath: piMcpConfigPath(agentDir) };
}

/** Read non-secret authentication metadata for one server. */
export function getMcpServerAuth(
  name: string,
  agentDir = resolvePiAgentDir(),
): McpAuthSnapshot {
  const server = readServer(name, agentDir);
  const metadata = authMetadata(server.entry);
  return {
    name: server.name,
    configPath: server.path,
    ...(typeof server.entry.url === "string" ? { url: redactUrl(server.entry.url) } : {}),
    ...metadata,
  };
}

function interpolateEnvVars(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, key: string) => process.env[key] ?? "")
    .replace(/\$env:(\w+)/g, (_, key: string) => process.env[key] ?? "")
    .replace(/\{env:(\w+)\}/g, (_, key: string) => process.env[key] ?? "");
}

/** Resolve an HTTP endpoint without returning it in validation errors. */
export function resolveMcpServerUrl(
  name: string,
  agentDir = resolvePiAgentDir(),
): string {
  const server = readServer(name, agentDir);
  if (typeof server.entry.url !== "string" || !server.entry.url.trim()) {
    throw new McpError("invalid-auth", "HTTP MCP サーバーのURLが設定されていません");
  }
  const template = server.entry.url;
  const missing = new Set<string>();
  for (const match of template.matchAll(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g)) {
    const key = match[1] ?? match[2] ?? match[3];
    if (key && process.env[key] === undefined) missing.add(key);
  }
  if (missing.size > 0) {
    throw new McpError("invalid-auth", "MCP サーバーURLの環境変数が未設定です");
  }

  const resolved = interpolateEnvVars(template);
  try {
    const parsed = new URL(resolved);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new McpError("invalid-auth", "MCP サーバーURLが不正です");
  }
  return resolved;
}

/** Configure the adapter-owned bearer credential store for a server. */
export function enableMcpBearerStore(
  name: string,
  agentDir = resolvePiAgentDir(),
): McpListResult {
  const server = readServer(name, agentDir);
  if (typeof server.entry.url !== "string" || !server.entry.url.trim()) {
    throw new McpError("invalid-auth", "Bearer認証はHTTP MCPサーバーでのみ利用できます");
  }

  server.entry.auth = "bearer";
  server.entry.bearerTokenStore = true;
  delete server.entry.headersStore;
  delete server.entry.oauth;
  // Remove local literal and environment references when the user explicitly
  // saves to the adapter-owned store. The store flag takes precedence over
  // inherited lower-precedence bearer fields in the adapter.
  delete server.entry.bearerToken;
  delete server.entry.bearerTokenEnv;
  atomicWrite(server.path, `${JSON.stringify(server.config, null, 2)}\n`);
  return listMcpServers(agentDir);
}

/** Stop using the adapter-owned bearer store without touching other config. */
export function disableMcpBearerStore(
  name: string,
  agentDir = resolvePiAgentDir(),
): McpListResult {
  const server = readServer(name, agentDir);
  if (server.entry.bearerTokenStore === true) {
    delete server.entry.bearerTokenStore;
    atomicWrite(server.path, `${JSON.stringify(server.config, null, 2)}\n`);
  }
  return listMcpServers(agentDir);
}

/** Configure the adapter-owned HTTP header credential store for a server. */
export function enableMcpHeadersStore(
  name: string,
  agentDir = resolvePiAgentDir(),
): McpListResult {
  const server = readServer(name, agentDir);
  if (typeof server.entry.url !== "string" || !server.entry.url.trim()) {
    throw new McpError("invalid-auth", "HTTPヘッダー認証はHTTP MCPサーバーでのみ利用できます");
  }

  server.entry.headersStore = true;
  // A user-selected header store is an explicit alternative to OAuth/Bearer.
  // Keep auth: false as an explicit mode marker so an inherited lower layer
  // cannot re-enable bearer authentication while this store is selected.
  server.entry.auth = false;
  delete server.entry.oauth;
  delete server.entry.bearerToken;
  delete server.entry.bearerTokenEnv;
  delete server.entry.bearerTokenStore;
  atomicWrite(server.path, `${JSON.stringify(server.config, null, 2)}\n`);
  return listMcpServers(agentDir);
}

/** Stop using the adapter-owned HTTP header credential store. */
export function disableMcpHeadersStore(
  name: string,
  agentDir = resolvePiAgentDir(),
): McpListResult {
  const server = readServer(name, agentDir);
  if (server.entry.headersStore === true) {
    delete server.entry.headersStore;
    if (server.entry.auth === false) delete server.entry.auth;
    atomicWrite(server.path, `${JSON.stringify(server.config, null, 2)}\n`);
  }
  return listMcpServers(agentDir);
}

export function setMcpServerEnabled(
  name: string,
  enabled: boolean,
  agentDir = resolvePiAgentDir(),
): McpListResult {
  const server = readServer(name, agentDir);
  if (enabled) delete server.entry.disabled;
  else server.entry.disabled = true;

  atomicWrite(server.path, `${JSON.stringify(server.config, null, 2)}\n`);
  return listMcpServers(agentDir);
}
