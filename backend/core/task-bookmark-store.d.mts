import type { TaskBookmark } from "@shared/types";

export const MAX_BOOKMARKS_PER_TASK: number;
export const MAX_BOOKMARK_PREVIEW_CHARS: number;

/** Whether `id` can address a task's bookmarks. */
export function isBookmarkTaskId(id: unknown): id is string;

export type TaskBookmarkInput = {
  messageId: string;
  role: "user" | "assistant";
  messageCreatedAt?: number;
  preview?: string;
};

export class TaskBookmarkStore {
  constructor(options: {
    filePath: () => string;
    now?: () => number;
    onCorrupt?: (error: Error) => void;
  });
  /** The task's bookmarks in timeline order. */
  list(taskId: string): TaskBookmark[];
  /** Add a bookmark (already-bookmarked messages keep their first entry); throws with `status` 400/409. */
  add(taskId: string, input: TaskBookmarkInput, options?: { knownTaskIds?: ReadonlySet<string> }): TaskBookmark[];
  /** Remove one bookmark; removing one that does not exist is not an error. */
  remove(taskId: string, messageId: string): TaskBookmark[];
}
