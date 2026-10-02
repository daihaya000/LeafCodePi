import type { McpExtensionOptions } from "@earendil-works/pi-coding-agent";
type SdkCredentials = NonNullable<McpExtensionOptions["credentials"]>;
/** All PUBLIC SDK methods, without the unexported concrete class's private fields. */
export type BackendMcpNativeCredentials = Pick<SdkCredentials, keyof SdkCredentials>;
export type BackendMcpOAuthServerStore = ReturnType<BackendMcpNativeCredentials["forServer"]>;
export type BackendMcpOAuthState = NonNullable<Awaited<ReturnType<BackendMcpOAuthServerStore["load"]>>>;
export type BackendMcpCredentialIdentity = Readonly<{ namespace: string; serverUrl: string }>;
export type BackendMcpCredentialOwner = {
  /** Throws unless the current process owns this configured identity. Must be synchronous. */
  assertOwner(identity: BackendMcpCredentialIdentity): void;
  /** Fixed owner storage, no implicit URL-only/legacy takeover. Synchronous. */
  readState(identity: BackendMcpCredentialIdentity): BackendMcpOAuthState | undefined;
  /** Synchronous durable write; partial failure does not imply rollback. */
  writeState(identity: BackendMcpCredentialIdentity, state: BackendMcpOAuthState): void;
  /** Synchronous deletion of ONLY this identity. */
  removeState(identity: BackendMcpCredentialIdentity): boolean;
  /** Must hold the owner cross-process lock until work settles, preserving its result/errors. */
  withRefreshLock<T>(identity: BackendMcpCredentialIdentity, work: () => Promise<T>): Promise<T>;
};
/** No IO during construction. Private owner boundary; not an HTTP/Web DTO or SDK class instance. */
export function createBackendMcpCredentials(owner: BackendMcpCredentialOwner): BackendMcpNativeCredentials;
