import type { BackendMcpCredentialOwner } from "./mcp-native-credentials.mjs";
import type { McpPublicAuthSnapshot } from "../../shared/mcp-auth-snapshot.mjs";
export type BackendMcpOAuthStatus = McpPublicAuthSnapshot & {
  authType: "oauth";
  credentialSource: "oauth";
  credentialStatus: "present" | "missing" | "expired" | "unknown";
};
/** Read-only, synchronous OAuth metadata for an endpoint selected and authorized by the owner.
 * No constructor IO, implicit storage, auth-type inference, refresh or session/route activation.
 * Does not call owner writers or refresh locks; injected reads may use temporary document locks.
 * SDK expiry is milliseconds. Missing relative-TTL anchors are unknown; present is NOT online acceptance.
 * Throws a sanitized error on ownership/storage/identity/clock failure; no empty-success fallback. */
export function createBackendMcpOAuthStatusReader(options: {
  owner: BackendMcpCredentialOwner;
  /** Unix epoch milliseconds, synchronous; captured once, invoked only when reading. */
  now?: () => number;
}): (name: string, serverUrl: string) => BackendMcpOAuthStatus;
