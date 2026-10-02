import type { ExtensionFactory, McpExtensionOptions } from "@earendil-works/pi-coding-agent";
import type { McpConfigLoaderIssue } from "./mcp-native-config-loader.mjs";
import type { BackendMcpNativeCredentials } from "./mcp-native-credentials.mjs";
export type BackendMcpOwnerServices = {
  credentials: BackendMcpNativeCredentials;
  openUrl: NonNullable<McpExtensionOptions["openUrl"]>;
  updateConfig: NonNullable<McpExtensionOptions["updateConfig"]>;
} & Pick<McpExtensionOptions, "createTransport" | "startupWaitMs">;
export type BackendMcpExtensionsResult =
  | { ok: false; issues: McpConfigLoaderIssue[]; factories: null }
  | { ok: true; issues: []; sourceSha256: string | null; bundledSha256: string; serverCount: number;
      factories: [ExtensionFactory, ExtensionFactory, ExtensionFactory] };
/** Composition only; owner writer/credential/permission barriers must precede session binding. */
export function prepareBackendMcpExtensions(options?: {
  agentDir: string;
  bundledConfigPath: string;
  urlVariables?: Record<string, string>;
  mcp: BackendMcpOwnerServices;
}): Promise<BackendMcpExtensionsResult>;
