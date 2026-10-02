import type { McpExtensionOptions } from "@earendil-works/pi-coding-agent";
export type McpConfigLoaderIssue = { code: string; field?: string; server?: string };
export type BackendMcpConfigLoaderResult =
  | { ok: false; issues: McpConfigLoaderIssue[]; loadConfig: null }
  | { ok: true; issues: []; sourceSha256: string | null; bundledSha256: string; serverCount: number;
      loadConfig: NonNullable<McpExtensionOptions["loadConfig"]> };
/** Internal preparation only. Callback results contain private configuration. */
export function prepareBackendMcpConfigLoader(options?: {
  agentDir: string;
  bundledConfigPath: string;
  urlVariables?: Record<string, string>;
}): Promise<BackendMcpConfigLoaderResult>;
