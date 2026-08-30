import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  destroyArchivedTasksByProject: vi.fn(),
  getTaskSummariesWithTodoProgress: vi.fn(),
  listModelsForAccounts: vi.fn(),
  listPendingAttention: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => mocks);

import { POST } from "./route";

describe("POST /api/tasks", () => {
  beforeEach(() => {
    mocks.createTask.mockReset();
    mocks.createTask.mockResolvedValue({ id: "task-1" });
  });

  it("passes null as the project id for a no-project task", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        body: JSON.stringify({ projectId: null, prompt: "一時作業" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: null, prompt: "一時作業" }),
    );
  });

  it("rejects a missing or empty project id instead of silently selecting no-project", async () => {
    for (const body of [{ prompt: "作業" }, { projectId: "", prompt: "作業" }]) {
      mocks.createTask.mockClear();
      const response = await POST(
        new NextRequest("http://localhost/api/tasks", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );

      expect(response.status).toBe(400);
      expect(mocks.createTask).not.toHaveBeenCalled();
    }
  });
});
