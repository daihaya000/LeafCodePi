import { describe, expect, it } from "vitest";
import { taskSidebarNotifyKey } from "./task-sidebar-notify";

const task = {
  id: "task-1",
  status: "idle" as const,
  title: "タスクA",
  goalLoopSummary: { status: "queued" as const, maxTurns: 10, turnCount: 1 },
};

describe("taskSidebarNotifyKey", () => {
  it("changes when Goal Loop progress changes", () => {
    expect(
      taskSidebarNotifyKey(task),
    ).not.toBe(taskSidebarNotifyKey({ ...task, goalLoopSummary: { ...task.goalLoopSummary, turnCount: 2 } }));
  });

  it("does not require loop state for ordinary tasks", () => {
    expect(taskSidebarNotifyKey({ ...task, goalLoopSummary: undefined })).toBe("task-1|idle|タスクA|||");
  });
});
