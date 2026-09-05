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
    const status = payload.task.status;
    const isStreaming =
      status === "working"
        ? (payload.isStreaming ?? status === "working")
        : false;
    return {
      ...payload.task,
      messages: [],
      isStreaming,
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

  const nextStatus = payload.task?.status ?? current.status;
  let isStreaming = current.isStreaming;
  if ("isStreaming" in payload) {
    isStreaming = payload.isStreaming ?? current.isStreaming;
  } else if (payload.task && "status" in payload.task) {
    isStreaming = nextStatus === "working" ? current.isStreaming : false;
  }
  // Throttled pre-abort deltas can arrive after an idle snapshot. Streaming
  // without status working would make the client treat the task as busy.
  if (nextStatus !== "working") isStreaming = false;

  return {
    ...current,
    ...(payload.task ?? {}),
    isStreaming,
    ...("isCompacting" in payload
      ? { isCompacting: payload.isCompacting ?? current.isCompacting }
      : {}),
    ...("contextUsage" in payload
      ? { contextUsage: payload.contextUsage ?? current.contextUsage }
      : {}),
  };
}
