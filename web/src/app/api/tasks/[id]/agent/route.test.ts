import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  setTaskAgent: vi.fn(),
  forwardTaskAgent: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
}));

vi.mock("@/lib/pi/harness", () => mocks);
vi.mock("@/lib/backend-forward", () => ({ forwardTaskAgent: mocks.forwardTaskAgent }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));

describe("POST /api/tasks/[id]/agent", () => {
  beforeEach(() => {
    mocks.jsonError.mockClear();
    mocks.setTaskAgent.mockReset();
    mocks.forwardTaskAgent.mockReset();
    mocks.forwardTaskAgent.mockResolvedValue({ ok: true, task: { id: "task-1", agent: "reviewer" } });
    mocks.localRuntimeBlocked.mockReturnValue(false);
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

  it("forwards the change after the cutover and can clear the agent", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);

    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/agent", {
        method: "POST",
        body: JSON.stringify({ agent: "" }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.forwardTaskAgent).toHaveBeenCalledWith("task-1", "");
    expect(mocks.setTaskAgent).not.toHaveBeenCalled();
  });
});
