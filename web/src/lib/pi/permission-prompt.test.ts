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

  it("returns null (not false) when session cannot be mapped to a task", async () => {
    const emit = vi.fn();
    const service = createPermissionPromptService({
      resolveTaskId: () => null,
      emit,
      snapshotExtras: () => ({}),
    });

    await expect(
      service.handleRequest({
        id: "req-orphan",
        sessionId: "unknown",
        command: "rm -rf /",
        labels: ["rm -rf"],
        message: "allow?",
      }),
    ).resolves.toBeNull();
    expect(emit).not.toHaveBeenCalled();
    expect(service.pendingForTask("task-a")).toBeNull();
  });

  it("queues concurrent requests instead of auto-denying the first", async () => {
    const emit = vi.fn();
    const service = createPermissionPromptService({
      resolveTaskId: () => "task-a",
      emit,
      snapshotExtras: () => ({}),
    });

    const first = service.handleRequest({
      id: "req-1",
      sessionId: "sess-1",
      command: "rm -rf a",
      labels: ["rm -rf"],
      message: "first",
    });
    const second = service.handleRequest({
      id: "req-2",
      sessionId: "sess-1",
      command: "sudo apt",
      labels: ["sudo"],
      message: "second",
    });

    expect(service.pendingForTask("task-a")?.id).toBe("req-1");

    expect(service.respond("task-a", "req-1", true)).toBe(true);
    await expect(first).resolves.toBe(true);
    expect(service.pendingForTask("task-a")?.id).toBe("req-2");

    expect(service.respond("task-a", "req-2", false)).toBe(true);
    await expect(second).resolves.toBe(false);
    expect(service.pendingForTask("task-a")).toBeNull();
  });

  it("lists only tasks with pending requests", async () => {
    const service = createPermissionPromptService({
      resolveTaskId: (sessionId) => (sessionId === "sess-1" ? "task-a" : "task-b"),
      emit: vi.fn(),
      snapshotExtras: () => ({}),
    });
    expect([...service.pendingTaskIds()]).toEqual([]);

    void service.handleRequest({
      id: "req-1",
      sessionId: "sess-1",
      command: "ls",
      labels: ["ls"],
      message: "allow?",
    });
    expect([...service.pendingTaskIds()]).toEqual(["task-a"]);

    service.respond("task-a", "req-1", true);
    expect([...service.pendingTaskIds()]).toEqual([]);
  });

  it("clears queued requests on abort so a later prompt is not blocked", async () => {
    const emit = vi.fn();
    const service = createPermissionPromptService({
      resolveTaskId: () => "task-a",
      emit,
      snapshotExtras: () => ({}),
    });
    const first = service.handleRequest({
      id: "req-1",
      sessionId: "sess-1",
      command: "rm -rf a",
      labels: ["rm -rf"],
      message: "first",
    });
    const second = service.handleRequest({
      id: "req-2",
      sessionId: "sess-1",
      command: "sudo apt",
      labels: ["sudo"],
      message: "second",
    });

    expect(service.clearPendingForTask("task-a")).toBe(true);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(service.pendingForTask("task-a")).toBeNull();
    expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({
      eventType: "permission_resolved",
      permissionRequest: null,
    });

    const third = service.handleRequest({
      id: "req-3",
      sessionId: "sess-1",
      command: "ls",
      labels: ["ls"],
      message: "third",
    });
    expect(service.pendingForTask("task-a")?.id).toBe("req-3");
    expect(service.respond("task-a", "req-3", true)).toBe(true);
    await expect(third).resolves.toBe(true);
  });
});
