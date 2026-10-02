import type { McpExtensionOptions } from "@earendil-works/pi-coding-agent";
import type { McpFetch } from "@earendil-works/pi-mcp";
import type { BackendMcpConfigBinding } from "./mcp-native-config-owner.mjs";
import type { BackendMcpConfigLocation } from "./mcp-native-config-file-writer.mjs";
import type { BackendMcpCredentialLocation } from "./mcp-native-credential-owner.mjs";
import type { BackendMcpExtensionsResult } from "./mcp-native-extensions.mjs";
import type { BackendMcpWriterScope } from "./mcp-native-write-coordinator.mjs";
export type BackendMcpPreparedRuntime = Readonly<{
  /** PRIVATE binding; never a DTO. */
  binding: BackendMcpConfigBinding;
  /** SDK extension family for one session cwd (url entries -> HTTP, others -> stdio). No activation. */
  forSession(sessionCwd: string): BackendMcpExtensionsResult;
}>;
export type BackendMcpNativeRuntime = Readonly<{
  /** Reads/validates the fixed sources once; retires older bindings. Reprepare after entered writes. */
  prepare(): Promise<BackendMcpPreparedRuntime>;
  runWrite<T>(work: (scope: BackendMcpWriterScope) => T | Promise<T>): Promise<T>;
  drain(): Promise<void>;
  dispose(): void;
}>;
/** INERT PRIVATE composition of config owner, credential authority/owner, stdio+HTTP transports and
 * SDK MCP/codemode/tool_search factories. No construction IO, activation, migration, writer
 * quiescence, OS election or adapter removal. Explicit env/variables/fetch/openUrl are mandatory.
 * Default storage checks are the strict read-only ACL policy (Windows spawns a metadata process). */
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
  storageChecks?: {
    config: (location: BackendMcpConfigLocation) => void;
    credentials: (location: BackendMcpCredentialLocation) => void;
  };
}): BackendMcpNativeRuntime;
