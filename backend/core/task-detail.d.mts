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

/** Budget for a detail read that may create a live session. */
export const TASK_DETAIL_TIMEOUT_MS: number;
/** Budget for the transcript fallback of a detail read. */
export const TASK_DETAIL_OFFLINE_TIMEOUT_MS: number;

/** Whether an error is a detail-read timeout. */
export function isDetailTimeoutError(error: unknown): boolean;

/** The error a timed-out stage reports: { message, status, timeout: true }. */
export function detailTimeoutError(stage: "live" | "offline" | "final"): {
  message: string;
  status: number;
  timeout: true;
};
