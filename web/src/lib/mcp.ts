/**
 * Bundled and global MCP servers with ON/OFF and credential metadata. User
 * overrides live in Pi's global file `~/.pi/agent/mcp.json`; this module writes
 * only that override while preserving bundled definitions as the base.
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
import { bundledExtensionsDir } from "@/lib/extensions";

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
  bundled: boolean;
  userConfigured: boolean;
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
  /** LeafCodePi bundled MCP config path, when available. */
  bundledConfigPath: string | null;
};

export class McpError extends Error {
  constructor(
    readonly code: "invalid-name" | "not-found" | "invalid-auth" | "auth-unavailable" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

export function mcpErrorStatus(error: unknown): number {
  if (error instanceof McpError) {
    if (error.code === "invalid-name" || error.code === "invalid-auth") return 400;
    if (error.code === "not-found") return 404;
    if (error.code === "conflict") return 409;
    if (error.code === "auth-unavailable") return 503;
  }
  return 500;
}

export function piMcpConfigPath(agentDir = resolvePiAgentDir()): string {
  return join(agentDir, "mcp.json");
}

type McpConfig = {
  mcpServers: Record<string, McpServer>;
  /** Other top-level keys (settings, imports, …) are preserved on rewrite. */
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpServer(value: unknown): value is McpServer {
  return isRecord(value);
}

function readConfig(path: string): McpConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(raw)) return { mcpServers: {} };
    const mcpServers = isRecord(raw.mcpServers)
      ? (raw.mcpServers as Record<string, McpServer>)
      : {};
    // Keep non-mcpServers top-level keys so writes never drop adapter settings.
    return { ...raw, mcpServers };
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

function bundledMcpConfigPath(): string | null {
  const extensionsRoot = bundledExtensionsDir();
  return extensionsRoot ? join(extensionsRoot, "leafcode-mcp-adapter", "mcp.json") : null;
}

function readBundledConfig(path = bundledMcpConfigPath()): McpConfig {
  return path ? readConfig(path) : { mcpServers: {} };
}

function mergeConfigs(base: McpConfig, override: McpConfig): McpConfig {
  const mcpServers = { ...base.mcpServers };
  for (const [name, entry] of Object.entries(override.mcpServers)) {
    mcpServers[name] = { ...(mcpServers[name] ?? {}), ...entry };
  }
  return { ...base, ...override, mcpServers };
}

function readEffectiveConfig(path: string): McpConfig {
  return mergeConfigs(readBundledConfig(), readConfig(path));
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
  const candidate = readEffectiveConfig(path).mcpServers[trimmed];
  if (!isMcpServer(candidate)) throw new McpError("not-found", "MCP サーバーが見つかりません");
  return { name: trimmed, path, config, entry: candidate };
}

function ensureUserServer(server: { name: string; config: McpConfig }): McpServer {
  const existing = server.config.mcpServers[server.name];
  if (isMcpServer(existing)) return existing;
  const entry: McpServer = {};
  server.config.mcpServers[server.name] = entry;
  return entry;
}

function removeEmptyUserServer(server: { name: string; config: McpConfig }): void {
  const entry = server.config.mcpServers[server.name];
  if (isMcpServer(entry) && Object.keys(entry).length === 0) delete server.config.mcpServers[server.name];
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

function dtoFor(name: string, entry: McpServer, bundled: boolean, userConfigured: boolean): McpDto {
  const metadata = authMetadata(entry);
  return {
    id: name,
    name,
    enabled: entry.disabled !== true,
    bundled,
    userConfigured,
    source: typeof entry.url === "string" ? "http" : "stdio",
    ...(typeof entry.url === "string" ? { url: redactUrl(entry.url) } : {}),
    ...metadata,
  };
}

export function listMcpServers(agentDir = resolvePiAgentDir()): McpListResult {
  const configPath = piMcpConfigPath(agentDir);
  const bundledConfigPath = bundledMcpConfigPath();
  const bundledConfig = readBundledConfig(bundledConfigPath);
  const userConfig = readConfig(configPath);
  const config = mergeConfigs(bundledConfig, userConfig);
  const servers = Object.entries(config.mcpServers)
    .filter(([, entry]) => isMcpServer(entry))
    .map(([name, entry]) => dtoFor(
      name,
      entry,
      Object.hasOwn(bundledConfig.mcpServers, name),
      Object.hasOwn(userConfig.mcpServers, name),
    ))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { servers, configPath, bundledConfigPath };
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

  const entry = ensureUserServer(server);
  entry.auth = "bearer";
  entry.bearerTokenStore = true;
  delete entry.headersStore;
  delete entry.oauth;
  // Remove local literal and environment references when the user explicitly
  // saves to the adapter-owned store. The store flag takes precedence over
  // inherited lower-precedence bearer fields in the adapter.
  delete entry.bearerToken;
  delete entry.bearerTokenEnv;
  atomicWrite(server.path, `${JSON.stringify(server.config, null, 2)}\n`);
  return listMcpServers(agentDir);
}

/** Stop using the adapter-owned bearer store without touching other config. */
export function disableMcpBearerStore(
  name: string,
  agentDir = resolvePiAgentDir(),
): McpListResult {
  const server = readServer(name, agentDir);
  const entry = server.config.mcpServers[server.name];
  if (isMcpServer(entry) && entry.bearerTokenStore === true) {
    delete entry.bearerTokenStore;
    removeEmptyUserServer(server);
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

  const entry = ensureUserServer(server);
  entry.headersStore = true;
  // A user-selected header store is an explicit alternative to OAuth/Bearer.
  // Keep auth: false as an explicit mode marker so an inherited lower layer
  // cannot re-enable bearer authentication while this store is selected.
  entry.auth = false;
  delete entry.oauth;
  delete entry.bearerToken;
  delete entry.bearerTokenEnv;
  delete entry.bearerTokenStore;
  atomicWrite(server.path, `${JSON.stringify(server.config, null, 2)}\n`);
  return listMcpServers(agentDir);
}

/** Stop using the adapter-owned HTTP header credential store. */
export function disableMcpHeadersStore(
  name: string,
  agentDir = resolvePiAgentDir(),
): McpListResult {
  const server = readServer(name, agentDir);
  const entry = server.config.mcpServers[server.name];
  if (isMcpServer(entry) && entry.headersStore === true) {
    delete entry.headersStore;
    if (entry.auth === false) delete entry.auth;
    removeEmptyUserServer(server);
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
  const existing = server.config.mcpServers[server.name];
  if (enabled) {
    if (isMcpServer(existing)) {
      delete existing.disabled;
      removeEmptyUserServer(server);
    } else if (server.entry.disabled === true) {
      ensureUserServer(server).disabled = false;
    } else {
      return listMcpServers(agentDir);
    }
  } else {
    ensureUserServer(server).disabled = true;
  }

  atomicWrite(server.path, `${JSON.stringify(server.config, null, 2)}\n`);
  return listMcpServers(agentDir);
}

/**
 * Normalize an n8n instance URL to its instance-level MCP endpoint. A bare
 * hostname is assumed to be https, and `/mcp-server/http` is appended when
 * the URL has no path, matching n8n's "Connect a client" Server URL.
 */
export function normalizeN8nServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new McpError("invalid-auth", "n8n のURLを入力してください");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new McpError("invalid-auth", "n8n のURLが不正です");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new McpError("invalid-auth", "n8n のURLは http(s) を指定してください");
  }
  if (!parsed.hostname) throw new McpError("invalid-auth", "n8n のURLが不正です");
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname === "" ? "/mcp-server/http" : pathname;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/** Add the n8n instance-level MCP server as an OAuth HTTP entry. */
export function addN8nServer(input: string, agentDir = resolvePiAgentDir()): McpListResult {
  const path = piMcpConfigPath(agentDir);
  const config = readConfig(path);
  if (isMcpServer(config.mcpServers["n8n"])) {
    throw new McpError("conflict", "n8n は既に登録されています");
  }
  const url = normalizeN8nServerUrl(input);
  config.mcpServers["n8n"] = {
    url,
    auth: "oauth",
    httpTransport: "streamable-http",
    protocolVersion: "auto",
  };
  atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
  return listMcpServers(agentDir);
}

/** Slack's hosted MCP endpoint (Streamable HTTP only). */
const SLACK_MCP_URL = "https://mcp.slack.com/mcp";

/**
 * Add the Slack hosted MCP server as an OAuth entry. Slack does not support
 * dynamic client registration, so the entry carries a pre-registered Slack
 * app client ID (PKCE; no client secret needed, matching Slack's own plugin).
 */
export function addSlackServer(clientId: string, agentDir = resolvePiAgentDir()): McpListResult {
  const id = clientId.trim();
  if (!id) throw new McpError("invalid-auth", "Slack のClient IDを入力してください");
  if (id.length > 256 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new McpError("invalid-auth", "Slack のClient IDが不正です（例: 1601185624273.8899143856786）");
  }
  const path = piMcpConfigPath(agentDir);
  const config = readConfig(path);
  if (isMcpServer(config.mcpServers["slack"])) {
    throw new McpError("conflict", "slack は既に登録されています");
  }
  config.mcpServers["slack"] = {
    url: SLACK_MCP_URL,
    auth: "oauth",
    httpTransport: "streamable-http",
    protocolVersion: "auto",
    oauth: { clientId: id },
  };
  atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
  return listMcpServers(agentDir);
}

/** Google Workspace remote MCP servers (Developer Preview). */
const GOOGLE_APIS_AUTH = "https://www.googleapis.com/auth/";
const GOOGLE_WORKSPACE_MCP_SERVERS: readonly { name: string; url: string; scopes: readonly string[] }[] = [
  { name: "gws-gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", scopes: ["gmail.readonly", "gmail.compose"] },
  { name: "gws-drive", url: "https://drivemcp.googleapis.com/mcp/v1", scopes: ["drive.readonly", "drive.file"] },
  {
    name: "gws-docs",
    url: "https://docsmcp.googleapis.com/mcp/v1",
    scopes: ["drive.readonly", "drive.file", "documents.readonly", "documents"],
  },
  {
    name: "gws-sheets",
    url: "https://sheetsmcp.googleapis.com/mcp/v1",
    scopes: ["drive.readonly", "drive.file", "spreadsheets.readonly", "spreadsheets"],
  },
  {
    name: "gws-slides",
    url: "https://slidesmcp.googleapis.com/mcp/v1",
    scopes: ["drive.readonly", "drive.file", "presentations.readonly", "presentations"],
  },
  {
    name: "gws-calendar",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    scopes: ["calendar.calendarlist.readonly", "calendar.events.freebusy", "calendar.events.readonly"],
  },
  {
    name: "gws-chat",
    url: "https://chatmcp.googleapis.com/mcp/v1",
    scopes: [
      "chat.spaces.readonly",
      "chat.memberships.readonly",
      "chat.messages.readonly",
      "chat.messages.create",
      "chat.users.readstate",
    ],
  },
  {
    name: "gws-people",
    url: "https://people.googleapis.com/mcp/v1",
    scopes: ["directory.readonly", "userinfo.profile", "contacts.readonly"],
  },
];

/**
 * Add the Google Workspace remote MCP servers as OAuth entries. Google does
 * not support dynamic client registration, so every product entry shares the
 * pre-registered OAuth client pair and carries its own product scopes.
 */
export function addGoogleWorkspaceServers(
  clientId: string,
  clientSecret: string,
  agentDir = resolvePiAgentDir(),
): McpListResult {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!id) throw new McpError("invalid-auth", "Google OAuth Client IDを入力してください");
  if (!secret) throw new McpError("invalid-auth", "Google OAuth Client Secretを入力してください");
  if (id.length > 256 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new McpError("invalid-auth", "Google OAuth Client IDが不正です");
  }
  if (secret.length > 256 || !/^[A-Za-z0-9._-]+$/.test(secret)) {
    throw new McpError("invalid-auth", "Google OAuth Client Secretが不正です");
  }
  const path = piMcpConfigPath(agentDir);
  const config = readConfig(path);
  for (const server of GOOGLE_WORKSPACE_MCP_SERVERS) {
    if (isMcpServer(config.mcpServers[server.name])) {
      throw new McpError("conflict", `${server.name} は既に登録されています`);
    }
  }
  for (const server of GOOGLE_WORKSPACE_MCP_SERVERS) {
    config.mcpServers[server.name] = {
      url: server.url,
      auth: "oauth",
      httpTransport: "streamable-http",
      protocolVersion: "auto",
      oauth: {
        clientId: id,
        clientSecret: secret,
        scope: server.scopes.map((scope) => `${GOOGLE_APIS_AUTH}${scope}`).join(" "),
        // Google issues a refresh token for the web-server flow only when
        // access_type=offline is requested.
        authorizationParams: { access_type: "offline" },
      },
    };
  }
  atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
  return listMcpServers(agentDir);
}

/** Notion's hosted MCP endpoint (OAuth with dynamic client registration). */
const NOTION_MCP_URL = "https://mcp.notion.com/mcp";

/**
 * Add Notion's hosted MCP server as an OAuth entry (DCR; no client ID needed).
 * Notion serves both Streamable HTTP and SSE, so no transport is forced and
 * the adapter keeps its streamable-first negotiation with SSE fallback.
 */
export function addNotionServer(agentDir = resolvePiAgentDir()): McpListResult {
  const path = piMcpConfigPath(agentDir);
  const config = readConfig(path);
  if (isMcpServer(config.mcpServers["notion"])) {
    throw new McpError("conflict", "notion は既に登録されています");
  }
  config.mcpServers["notion"] = {
    url: NOTION_MCP_URL,
    auth: "oauth",
    protocolVersion: "auto",
  };
  atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
  return listMcpServers(agentDir);
}
