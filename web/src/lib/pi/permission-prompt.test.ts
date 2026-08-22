import { describe, expect, it, vi } from "vitest";
import { createPermissionPromptService, taskIdForSession } from "./permission-prompt";

describe("taskIdForSession", () => {
  it("maps a live session id back to the harness task id", () => {
    const taskId = taskIdForSession("sess-1", [
      { taskId: "task-a", sessionId: "sess-1" },
      { taskId: "task-b", sessionId: "sess-2" },
    ]);
    expect(taskId).toBe("task-a");
  });
});

describe("createPermissionPromptService", () => {
  it("emits a permission request and resolves via respond()", async () => {
    const emit = vi.fn();
    const service = createPermissionPromptService({
      resolveTaskId: (sessionId) => (sessionId === "sess-1" ? "task-a" : null),
      emit,
      snapshotExtras: () => ({ isStreaming: false }),
    });

    const pending = service.handleRequest({
      id: "req-1",
      sessionId: "sess-1",
      command: "rm -rf node_modules",
      labels: ["rm -rf"],
      message: "allow?",
    });

    expect(service.pendingForTask("task-a")?.id).toBe("req-1");
    expect(emit).toHaveBeenCalled();

    expect(service.respond("task-a", "req-1", true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(service.pendingForTask("task-a")).toBeNull();
  });

  it("rejects unknown request ids", () => {
    const service = createPermissionPromptService({
      resolveTaskId: () => "task-a",
      emit: vi.fn(),
      snapshotExtras: () => ({}),
    });
    expect(service.respond("task-a", "missing", true)).toBe(false);
  });
});
