export type BackendMcpGenerationLease = Readonly<{
  /** Synchronous process/generation/local-revocation assertion. Safe error on failure. */
  assertOwner(): void;
  /** Idempotent, revokes only this handle. */
  revoke(): void;
}>;
export type BackendMcpGenerationOwner = Readonly<{
  /** Revokes the previous generation BEFORE checking process ownership. No rollback/revival on failure. */
  beginGeneration(): BackendMcpGenerationLease;
  /** Independent handle for the currently active generation; fails when inactive/disposed. */
  captureLease(): BackendMcpGenerationLease;
  /** Revokes all current handles; use BEFORE cooperative config writes/reloads. */
  invalidate(): void;
  /** Terminal shutdown, idempotent. */
  dispose(): void;
}>;
/** Process-local opaque monotonic generation fencing only, no construction IO or automatic activation.
 * No config/credential/session operations, external-process lease or writer barrier.
 * Process-owner failure/reentrant verification invalidates the whole generation.
 * Caller owns snapshot publication and invokes invalidation before cooperative writers. */
export function createBackendMcpGenerationOwner(options: {
  assertProcessOwner: () => void;
}): BackendMcpGenerationOwner;
