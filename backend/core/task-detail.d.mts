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

/** Bookkeeping fields a transcript detail read reports. */
export function offlineDetailFlags(task: {
  hangRetryCount?: number;
  revertLeafId?: string | null;
  manualAbortedAssistantId?: string | null;
} | null | undefined): {
  isCompacting: false;
  compactionSuggested: false;
  hangRetryCount: number;
  revertLeafId: string | null;
  manualAbortedAssistantId: string | null;
};

/** Bookkeeping fields a live detail read reports (session values win, stored values fall back). */
export function liveDetailFlags(input: {
  task: { hangRetryCount?: number; revertLeafId?: string | null; manualAbortedAssistantId?: string | null } | null | undefined;
  live: { hangRetryCount?: number; revertLeafId?: string | null; manualAbortedAssistantId?: string | null } | null | undefined;
}): { hangRetryCount: number; revertLeafId: string | null; manualAbortedAssistantId: string | null };

/** The status a failed live detail read is reported with, or null when it already carries one. */
export function liveDetailErrorStatus(error: unknown): number | null;
