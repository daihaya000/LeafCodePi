import { createPendingSnapshotStore } from "@backend-core/pending-snapshot-store.mjs";

/**
 * Process-local record of the last snapshot each task scheduled (pending or already
 * emitted), keyed by task id. It exists so a reader can tell what a task's last
 * visible change was without holding the live session; the SSE path itself is
 * unchanged and never reads it back.
 *
 * The store is a plain value with no timers: `scheduleTaskSnapshot` records into it,
 * and disposing a task's live clears its entry. The HTTP surface that will serve it
 * (the Backend's `/internal/pending-snapshots`) is not connected yet, so today this is
 * only written — see docs/plans/backend-process-separation.md.
 */
export const pendingSnapshots = createPendingSnapshotStore({ limit: 512 });
