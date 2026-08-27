import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  setTaskAgent: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);

describe("POST /api/tasks/[id]/agent", () => {
  beforeEach(() => {
    mocks.jsonError.mockClear();
    mocks.setTaskAgent.mockReset();
  });

  it("passes the selected agent to the task runtime", async () => {
    const task = { id: "task-1", agent: "reviewer" };
    mocks.setTaskAgent.mockResolvedValue(task);

    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/agent", {
        method: "POST",
        body: JSON.stringify({ agent: "reviewer" }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.setTaskAgent).toHaveBeenCalledWith("task-1", "reviewer");
    expect(await response.json()).toEqual({ task });
  });

  it("rejects a non-string agent value", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/agent", {
        method: "POST",
        body: JSON.stringify({ agent: null }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.setTaskAgent).not.toHaveBeenCalled();
  });
});
