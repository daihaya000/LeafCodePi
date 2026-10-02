import type { McpExtensionOptions } from "@earendil-works/pi-coding-agent";
import type { BackendMcpConfigLoaderResult } from "./mcp-native-config-loader.mjs";
import type { BackendMcpConfigLocation } from "./mcp-native-config-file-writer.mjs";
import type { BackendMcpWriterScope } from "./mcp-native-write-coordinator.mjs";
export type BackendMcpConfigBinding = Readonly<{
  /** Private revisions + guarded loader; never a DTO or unguarded snapshot callback. */
  prepared: Readonly<Extract<BackendMcpConfigLoaderResult, { ok: true }>>;
  /** Fixed private owner path for native extension logging; caller cannot select another root. */
  logPath: string;
  assertOwner: () => void;
  loadConfig: NonNullable<McpExtensionOptions["loadConfig"]>;
  updateConfig: NonNullable<McpExtensionOptions["updateConfig"]>;
}>;
export type BackendMcpConfigOwner = Readonly<{
  /** Closes old bindings immediately. Fresh binding only after serialized preparation/revision checks.
   * Call explicitly after entered SDK writes; consumer rebind/reload remains caller-owned. */
  prepare(): Promise<BackendMcpConfigBinding>;
  /** Same private cooperative FIFO; scope checks required before side effects after awaits. */
  runWrite<T>(work: (scope: BackendMcpWriterScope) => T | Promise<T>): Promise<T>;
  /** Snapshot wait, NOT an acceptance freeze. */
  drain(): Promise<void>;
  /** Terminal fencing; no force cancellation/rollback. drain remains available. */
  dispose(): void;
}>;
/** Inert, explicit authority/storage composition. No session activation, migration apply,
 * automatic reload/publication, external writer exclusion or OS ownership election. */
export function createBackendMcpConfigOwner(options: {
  agentDir: string;
  bundledConfigPath: string;
  urlVariables?: Record<string, string>;
  assertProcessOwner: () => void;
  assertPrivateStorage: (location: BackendMcpConfigLocation) => void;
}): BackendMcpConfigOwner;
