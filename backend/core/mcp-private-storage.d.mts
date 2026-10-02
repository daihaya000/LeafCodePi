import type { BackendMcpCredentialLocation } from "./mcp-native-credential-owner.mjs";
import type { BackendMcpConfigLocation } from "./mcp-native-config-file-writer.mjs";
export type McpWindowsAcl = { ownerSid: string; daclPresent: boolean;
  rules: { sid: string; type: number; mask: number; flags: number }[] };
export type McpStoragePermissionSnapshot =
  | { platform: "win32"; currentSid: string; local: boolean; directory: McpWindowsAcl; file: McpWindowsAcl | null }
  | { platform: "linux"; currentUid: number; fsType: number;
      directory: { uid: number; mode: number }; file: { uid: number; mode: number } | null };
/** Pure internal policy; throws a value/path-free error on unknown or unsafe metadata. */
export function assertMcpStoragePermissions(snapshot: McpStoragePermissionSnapshot): void;
/** Fresh, synchronous, read-only metadata check for fixed owner paths. No construction IO or permission changes.
 * Windows DACL and supported Linux local filesystems only; other platforms fail closed.
 * Not a sandbox, effective-access solver, or guarantee against ancestor/path-replacement races. */
export function createBackendMcpPrivateStorageCheck(options: { agentDir: string }): (location: BackendMcpCredentialLocation) => void;
/** Fixed mcp.json, identical strict read-only policy/inheritance; no caller-selected target. */
export function createBackendMcpConfigStorageCheck(options: { agentDir: string }): (location: BackendMcpConfigLocation) => void;
