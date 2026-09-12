import { describe, expect, it } from "vitest";
import type { TaskDetail } from "./types";
import { mergeTaskDelta } from "./task-delta";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "task-1",
    projectId: "project-1",
    projectName: "Project",
    title: "Delta",
    directory: "C:\\project",
    isolation: "current_folder",
    status: "working",
    sessionId: "session-1",
    sessionFile: "C:\\session.jsonl",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    isStreaming: true,
    isCompacting: false,
    ...overrides,
  };
}

describe("mergeTaskDelta", () => {
  it("applies streaming flags when the delta omits the task summary", () => {
    const current = task();

    expect(
      mergeTaskDelta(current, { isStreaming: false, isCompacting: true }),
    ).toMatchObject({ isStreaming: false, isCompacting: true });
  });

  it("keeps the current task for a message-only delta", () => {
    const current = task();

    expect(mergeTaskDelta(current, {})).toBe(current);
  });

  it("ignores stale isStreaming after the task is already idle", () => {
    const current = task({ status: "idle", isStreaming: false });

    expect(mergeTaskDelta(current, { isStreaming: true })).toMatchObject({
      status: "idle",
      isStreaming: false,
    });
  });

  it("propagates the compaction suggestion state", () => {
    const current = task();

    expect(mergeTaskDelta(current, { compactionSuggested: true })).toMatchObject({
      compactionSuggested: true,
    });
  });
});
