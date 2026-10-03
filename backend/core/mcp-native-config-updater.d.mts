import type { McpExtensionOptions } from "@earendil-works/pi-coding-agent";
import type { BackendMcpConfigLoaderResult } from "./mcp-native-config-loader.mjs";
import type { BackendMcpWriteCoordinator, BackendMcpWriterScope } from "./mcp-native-write-coordinator.mjs";
export type BackendMcpConfigWriteRequest = Readonly<{
  configPath: string;
  bundledConfigPath: string;
  expectedSha256: string | null;
  expectedBundledSha256: string;
  serverName: string;
  patch: Readonly<Parameters<NonNullable<McpExtensionOptions["updateConfig"]>>[1]>;
}>;
/** PRIVATE synchronous IO dependency, NOT a default SDK writer or Web DTO.
 * Must enforce fixed paths/both revisions/native document/server, private storage and file
 * exclusion, and assert scope before atomic commit. Undefined acknowledgment, no async IO. */
export type BackendMcpConfigWrite = (request: BackendMcpConfigWriteRequest, scope: BackendMcpWriterScope) => undefined;
export type BackendMcpConfigUpdater = NonNullable<McpExtensionOptions["updateConfig"]> & {
  /** Owner-only auth write (not part of the SDK patch contract): bounded header values, null removes
   * the header (case-insensitive). Consumes the same snapshot/attempt as a settings update. */
  writeHeaders(entry: Parameters<NonNullable<McpExtensionOptions["updateConfig"]>>[0],
    headers: Readonly<Record<string, string | null>>): void;
};
/** Fixed global settings-only boundary, no constructor IO/runtime calls. Successful loader
 * snapshot callback is captured once. Consumed after every entered attempt, including failure;
 * reprepare/rebind for the next attempt. No migration/reload/activation/rollback/default writer. */
export function createBackendMcpConfigUpdater(options: {
  agentDir: string;
  bundledConfigPath: string;
  prepared: Extract<BackendMcpConfigLoaderResult, { ok: true }>;
  coordinator: Pick<BackendMcpWriteCoordinator, "runWriteSync">;
  assertSnapshotOwner: () => void;
  writeConfig: BackendMcpConfigWrite;
}): BackendMcpConfigUpdater;
