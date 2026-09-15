import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  handoffTaskToBot: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);

describe("POST /api/tasks/[id]/supervisor", () => {
  beforeEach(() => {
    mocks.jsonError.mockClear();
    mocks.handoffTaskToBot.mockReset();
  });

  it("passes the selected Bot and task to the runtime", async () => {
    const task = { id: "task-1", supervisorBotId: "bot-1" };
    mocks.handoffTaskToBot.mockResolvedValue(task);

    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/supervisor", {
        method: "POST",
        body: JSON.stringify({ botId: "bot-1" }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.handoffTaskToBot).toHaveBeenCalledWith("bot-1", "task-1");
    expect(await response.json()).toEqual({ task });
  });

  it("rejects a blank Bot id", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/supervisor", {
        method: "POST",
        body: JSON.stringify({ botId: "  " }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.handoffTaskToBot).not.toHaveBeenCalled();
  });
});
