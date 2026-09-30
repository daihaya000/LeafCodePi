/** Which source answers a task-detail read. */
export function resolveTaskDetailSource(input: {
  isArchived: boolean;
  isForeignLease: boolean;
  offline: boolean;
}): "archived" | "offline" | "live";

/** The streaming flag a detail read reports; null means the caller keeps its own value. */
export function detailStreamingFlag(source: string, taskStatus: string | undefined): boolean | null;

/** Whether the Goal Loop state belongs in the payload for this source. */
export function detailIncludesGoalLoop(source: string): boolean;
