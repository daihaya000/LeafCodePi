import type { TaskStatus } from "./types";

export type WorktreeStatus = Extract<TaskStatus, "ready" | "idle">;

export function statusFromChangedFileCount(count: number): WorktreeStatus {
  return count > 0 ? "ready" : "idle";
}
