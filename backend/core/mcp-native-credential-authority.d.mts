import type { BackendMcpConfigLoaderResult } from "./mcp-native-config-loader.mjs";
import type { BackendMcpCredentialIdentity } from "./mcp-native-credentials.mjs";
/** Credential-storage authority only, not permission to connect or call tools. */
export type BackendMcpCredentialAuthority = (identity: BackendMcpCredentialIdentity) => void;
/** Captures a successful pure fixed-owner loader snapshot. No filesystem/runtime calls in construction.
 * Checks the exact configured OAuth-eligible namespace/URL, fixed source hashes and explicit runtime
 * lease on each assertion. Observed lease/revision/read failures fence this instance permanently.
 * Configured disabled entries are allowed for credential management. Stdio/header/provider auth are not.
 * No credential reads/writes/locks or activation. This is NOT a writer barrier/CAS/ABA-proof sandbox. */
export function createBackendMcpCredentialAuthority(options: {
  agentDir: string;
  bundledConfigPath: string;
  prepared: Extract<BackendMcpConfigLoaderResult, { ok: true }>;
  /** Synchronous process-owned monotonic generation/lease assertion; throws on revocation. */
  assertRuntimeOwner: () => void;
}): BackendMcpCredentialAuthority;
