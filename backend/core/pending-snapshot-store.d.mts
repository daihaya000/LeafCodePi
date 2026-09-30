export type PendingSnapshotEntry = {
  taskId: string;
  eventType: string | null;
  extra: Record<string, unknown> | undefined;
  isDelta: boolean;
};

export type PendingSnapshotStore = {
  /** Records the pending snapshot for a task; false when the store keeps nothing. */
  record(taskId: string, snapshot: { eventType?: string | null; extra?: Record<string, unknown>; isDelta?: boolean }): boolean;
  /** The recorded snapshot, or null. Never the stored object itself. */
  read(taskId: string): PendingSnapshotEntry | null;
  /** Drops a task's entry; true when one was present. */
  clear(taskId: string): boolean;
  /** Every entry in least-recently-written order. */
  list(): PendingSnapshotEntry[];
  readonly size: number;
};

export function createPendingSnapshotStore(options?: { limit?: number }): PendingSnapshotStore;
