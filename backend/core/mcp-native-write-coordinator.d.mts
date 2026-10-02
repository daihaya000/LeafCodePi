import type { BackendMcpGenerationLease } from "./mcp-native-generation-lease.mjs";
export type BackendMcpWriterScope = Readonly<{
  /** Synchronous authority/lifetime check; MUST call before side effects/commits after awaits. */
  assertOwner(): void;
}>;
export type BackendMcpWriteCoordinator = Readonly<{
  beginGeneration(): BackendMcpGenerationLease;
  captureLease(): BackendMcpGenerationLease;
  /** FIFO; immediately invalidates old leases. Pending work blocks generation publication. */
  runWrite<T>(work: (scope: BackendMcpWriterScope) => T | Promise<T>): Promise<T>;
  /** SDK updateConfig boundary: completes/throws inline, only when FIFO idle. No async callbacks.
   * Explicit undefined (NOT void) prevents TypeScript's async-to-void assignability trap.
   * Callbacks/results must remain synchronous; partial side effects cannot be rolled back. */
  runWriteSync(work: (scope: BackendMcpWriterScope) => undefined): void;
  /** Waits work already accepted; not a freeze. Nested writer-context drain is rejected. */
  drain(): Promise<void>;
  /** Terminal fence, not cancellation/rollback of a running callback. Call drain for accepted work. */
  dispose(): void;
}>;
/** Process-local cooperative writer coordination only. Explicit synchronous process authority,
 * no constructor callbacks/IO, default store, direct file operations, cross-process lease or activation.
 * Private results are NOT HTTP DTOs. Errors are sanitized; failed/partial writes are not rolled back.
 * Caller must route every cooperative writer through this instance; external writers remain separate. */
export function createBackendMcpWriteCoordinator(options: {
  assertProcessOwner: () => void;
}): BackendMcpWriteCoordinator;
