import type { TaskDetail, TaskSummary } from "./types";

export type TaskDeltaState = {
  task?: TaskSummary;
  isStreaming?: boolean;
  isCompacting?: boolean;
  contextUsage?: TaskDetail["contextUsage"];
};

/** Merge the task state carried by a high-frequency delta without requiring a task summary. */
export function mergeTaskDelta(
  current: TaskDetail | null,
  payload: TaskDeltaState,
): TaskDetail | null {
  if (!current) {
    if (!payload.task) return current;
    return {
      ...payload.task,
      messages: [],
      isStreaming: payload.isStreaming ?? payload.task.status === "working",
      isCompacting: Boolean(payload.isCompacting),
    };
  }

  if (
    !payload.task &&
    !("isStreaming" in payload) &&
    !("isCompacting" in payload) &&
    !("contextUsage" in payload)
  ) {
    return current;
  }

  return {
    ...current,
    ...(payload.task ?? {}),
    ...("isStreaming" in payload
      ? { isStreaming: payload.isStreaming ?? current.isStreaming }
      : {}),
    ...("isCompacting" in payload
      ? { isCompacting: payload.isCompacting ?? current.isCompacting }
      : {}),
    ...("contextUsage" in payload
      ? { contextUsage: payload.contextUsage ?? current.contextUsage }
      : {}),
  };
}
