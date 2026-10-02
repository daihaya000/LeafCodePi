import type { BackendMcpConfigWrite } from "./mcp-native-config-updater.mjs";
export type BackendMcpConfigLocation = Readonly<{ agentDir: string; configPath: string }>;
/** INTERNAL fixed existing native config writer. Constructor has no IO.
 * Mandatory fresh private-file/directory-inheritance/local-filesystem attestation.
 * No permission changes, default SDK writer, creation/import/migration or session reload.
 * Exclusive non-reclaiming native-write lock; other writer protocols must be quiesced.
 * Temp fsync + rename, not a filesystem CAS/sandbox or directory durability guarantee.
 * IO/cleanup failures may be partial, including after successful rename. */
export function createBackendMcpConfigFileWriter(options: {
  agentDir: string;
  bundledConfigPath: string;
  assertPrivateStorage: (location: BackendMcpConfigLocation) => void;
}): BackendMcpConfigWrite;
