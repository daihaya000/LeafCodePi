import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  botIdForCodeTask: vi.fn(),
  abortTaskIncludingColdGoalLoop: vi.fn(),
  stopBotCodeTask: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500,
  })),
}));

vi.mock("@/lib/pi/bot-code-relay", () => ({ botIdForCodeTask: mocks.botIdForCodeTask }));
vi.mock("@/lib/pi/harness", () => ({
  abortTaskIncludingColdGoalLoop: mocks.abortTaskIncludingColdGoalLoop,
  stopBotCodeTask: mocks.stopBotCodeTask,
  jsonError: mocks.jsonError,
}));

import { POST } from "./route";

function request(): NextRequest {
  return new NextRequest("http://localhost/api/tasks/code-1/abort", { method: "POST" });
}

describe("POST /api/tasks/[id]/abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.botIdForCodeTask.mockReturnValue(undefined);
    mocks.abortTaskIncludingColdGoalLoop.mockResolvedValue({ id: "code-1", status: "idle" });
    mocks.stopBotCodeTask.mockResolvedValue({ id: "code-1", status: "idle", botId: "bot-1" });
  });

  it("uses a plain abort for ordinary Code tasks", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: "code-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.abortTaskIncludingColdGoalLoop).toHaveBeenCalledWith("code-1");
    expect(mocks.stopBotCodeTask).not.toHaveBeenCalled();
  });

  it("marks Bot-owned Code outbox stopped via stopBotCodeTask", async () => {
    mocks.botIdForCodeTask.mockReturnValue("bot-1");
    const response = await POST(request(), { params: Promise.resolve({ id: "code-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.stopBotCodeTask).toHaveBeenCalledWith("bot-1", "code-1");
    expect(mocks.abortTaskIncludingColdGoalLoop).not.toHaveBeenCalled();
  });
});
