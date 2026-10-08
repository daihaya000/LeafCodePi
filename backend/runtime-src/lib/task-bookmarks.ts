import { join } from "node:path";
import {
  TaskBookmarkStore,
  isBookmarkTaskId,
} from "@backend-core/task-bookmark-store.mjs";
import { dataDir } from "./paths";
import { listTasks } from "./store";

export { isBookmarkTaskId };

/** Message bookmarks of every task, kept beside the application store (`task-bookmarks.json`). */
export const taskBookmarks = new TaskBookmarkStore({
  filePath: () => join(dataDir(), "task-bookmarks.json"),
});

/** Ids of every stored task (Code, Bot and archived), used to prune bookmarks of deleted tasks. */
export function storedTaskIds(): Set<string> {
  return new Set(listTasks(true, "all").map((task) => task.id));
}
