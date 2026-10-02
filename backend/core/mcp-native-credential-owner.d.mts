import type { BackendMcpCredentialIdentity, BackendMcpCredentialOwner } from "./mcp-native-credentials.mjs";
/** Private paths for the owner's ACL attestation; never an API response. */
export type BackendMcpCredentialLocation = Readonly<{ agentDir: string; credentialPath: string }>;
/** Inactive file primitive, no construction IO; no production migration or session binding. */
export function createBackendMcpCredentialOwner(options: {
  agentDir: string;
  /** Synchronous Backend/configured-identity attestation; throws on failure. */
  assertOwner(identity: BackendMcpCredentialIdentity): void;
  /** Synchronous LOCAL private directory + file ACL attestation, including atomic-replacement inheritance. */
  assertPrivateStorage(location: BackendMcpCredentialLocation): void;
}): BackendMcpCredentialOwner;
