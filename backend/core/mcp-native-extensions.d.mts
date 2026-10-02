import type { ExtensionFactory, McpExtensionOptions } from "@earendil-works/pi-coding-agent";
import type { McpConfigLoaderIssue } from "./mcp-native-config-loader.mjs";
import type { BackendMcpNativeCredentials } from "./mcp-native-credentials.mjs";
import type { BackendMcpConfigBinding } from "./mcp-native-config-owner.mjs";
export type BackendMcpOwnerServices = {
  credentials: BackendMcpNativeCredentials;
  openUrl: NonNullable<McpExtensionOptions["openUrl"]>;
  updateConfig: NonNullable<McpExtensionOptions["updateConfig"]>;
} & Pick<McpExtensionOptions, "createTransport" | "startupWaitMs">;
export type BackendMcpExtensionsResult =
  | { ok: false; issues: McpConfigLoaderIssue[]; factories: null }
  | { ok: true; issues: []; sourceSha256: string | null; bundledSha256: string; serverCount: number;
      factories: [ExtensionFactory, ExtensionFactory, ExtensionFactory] };
export type BackendMcpBoundOwnerServices = Omit<BackendMcpOwnerServices, "updateConfig">;
/** Synchronous composition from a private prepared owner binding. No fresh snapshot read,
 * SDK fallback or implicit reprepare. Registration checks are not transactional/session activation;
 * refuse publication on any error. Connected tools/OAuth/nested permissions remain separate gates. */
export function prepareBackendMcpExtensionsFromBinding(options: {
  binding: BackendMcpConfigBinding;
  mcp: BackendMcpBoundOwnerServices;
}): BackendMcpExtensionsResult;
/** Unbound preparation only; never the guarded owner/session publication path.
 * Owner writer/credential/permission barriers must precede session binding. */
export function prepareBackendMcpExtensions(options?: {
  agentDir: string;
  bundledConfigPath: string;
  urlVariables?: Record<string, string>;
  mcp: BackendMcpOwnerServices;
}): Promise<BackendMcpExtensionsResult>;
