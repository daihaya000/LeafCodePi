import type { McpExtensionOptions, LoadedMcpConfig } from "@earendil-works/pi-coding-agent";
import type { McpFetch } from "@earendil-works/pi-mcp";
import type { BackendMcpConfigBinding } from "./mcp-native-config-owner.mjs";
import type { BackendMcpOAuthStatus } from "./mcp-native-oauth-status.mjs";
import type { McpPublicAuthSnapshot } from "../../shared/mcp-auth-snapshot.mjs";
import type { BackendMcpConfigLocation } from "./mcp-native-config-file-writer.mjs";
import type { BackendMcpCredentialLocation } from "./mcp-native-credential-owner.mjs";
import type { BackendMcpExtensionsResult } from "./mcp-native-extensions.mjs";
import type { BackendMcpWriterScope } from "./mcp-native-write-coordinator.mjs";
export type BackendMcpPreparedRuntime = Readonly<{
  /** PRIVATE binding; never a DTO. */
  binding: BackendMcpConfigBinding;
  /** PRIVATE resolved snapshot (`!command` env/header values already substituted); never a DTO. */
  snapshot: LoadedMcpConfig;
  /** SDK extension family for one session cwd (url entries -> HTTP, others -> stdio). No activation. */
  forSession(sessionCwd: string): BackendMcpExtensionsResult;
  /** Read-only native auth status for one configured entry of this snapshot; never refreshes/writes. */
  readAuthStatus(name: string): McpPublicAuthSnapshot;
  /** PRIVATE OAuth-only status (configured HTTP endpoints); kept for callers that want the store only. */
  readOAuthStatus(name: string): BackendMcpOAuthStatus;
  /** Owner-only OAuth credential removal for one configured endpoint; true when something was stored.
   * Does not cancel an in-flight refresh or pending login. */
  removeOAuth(name: string): boolean;
}>;
export type BackendMcpNativeRuntime = Readonly<{
  /** Reads/validates the fixed sources once; retires older bindings. Reprepare after entered writes. */
  prepare(): Promise<BackendMcpPreparedRuntime>;
  /** Prepare + install as the process session provider (the only install path). A failed reload
   * leaves the previous provider installed, but its retired binding fails closed. New sessions only. */
  install(): Promise<BackendMcpPreparedRuntime>;
  /** Owner-only auth write (headers, null removes): retires the current binding, republishes and
   * returns the fresh handle. Running sessions keep their snapshot. */
  writeAuth(name: string, headers: Readonly<Record<string, string | null>>): Promise<BackendMcpPreparedRuntime>;
  runWrite<T>(work: (scope: BackendMcpWriterScope) => T | Promise<T>): Promise<T>;
  drain(): Promise<void>;
  dispose(): void;
}>;
/** INERT PRIVATE composition of config owner, credential authority/owner, stdio+HTTP transports and
 * SDK MCP/codemode/tool_search factories. No construction IO, activation, migration, writer
 * quiescence, OS election or adapter removal. Explicit env/variables/fetch/openUrl are mandatory and
 * transport environment/variables are snapshotted at construction. Default storage checks are the
 * strict read-only ACL policy (Windows spawns a metadata process). `install()` is the only provider
 * installation path; it does not reload running sessions. */
export function createBackendMcpNativeRuntime(options: {
  agentDir: string;
  bundledConfigPath: string;
  homeDir: string;
  environment: Readonly<Record<string, string>>;
  variables: Readonly<Record<string, string>>;
  fetch: McpFetch;
  openUrl: NonNullable<McpExtensionOptions["openUrl"]>;
  assertProcessOwner: () => void;
  urlVariables?: Record<string, string>;
  startupWaitMs?: number;
  /** Synchronous resolver for adapter-style `!command` env/header secrets; shell/timeout policy is
   * the caller's. Omitted means markers stay and only the affected server is refused. */
  envCommands?: { run: (command: string) => string | undefined };
  storageChecks?: {
    config: (location: BackendMcpConfigLocation) => void;
    credentials: (location: BackendMcpCredentialLocation) => void;
  };
}): BackendMcpNativeRuntime;
