import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  botTaskId: vi.fn((id: string) => `bot:${id}`),
  abortTaskIncludingColdGoalLoop: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/bots", () => ({
  getBot: mocks.getBot,
  botTaskId: mocks.botTaskId,
}));

vi.mock("@/lib/pi/harness", () => ({
  abortTaskIncludingColdGoalLoop: mocks.abortTaskIncludingColdGoalLoop,
  jsonError: mocks.jsonError,
}));

describe("POST /api/bots/[id]/abort", () => {
  beforeEach(() => {
    mocks.getBot.mockReset();
    mocks.botTaskId.mockClear();
    mocks.abortTaskIncludingColdGoalLoop.mockReset();
    mocks.jsonError.mockClear();
  });

  it("stops cold Goal Loops via abortTaskIncludingColdGoalLoop", async () => {
    mocks.getBot.mockReturnValue({ id: "one" });
    mocks.abortTaskIncludingColdGoalLoop.mockResolvedValue({
      id: "bot:one",
      status: "idle",
    });

    const response = await POST(new NextRequest("http://127.0.0.1/api/bots/one/abort"), {
      params: Promise.resolve({ id: "one" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.abortTaskIncludingColdGoalLoop).toHaveBeenCalledWith("bot:one");
    expect(await response.json()).toEqual({
      task: { id: "bot:one", status: "idle" },
    });
  });

  it("returns 404 when the bot is missing", async () => {
    mocks.getBot.mockReturnValue(null);
    const response = await POST(new NextRequest("http://127.0.0.1/api/bots/missing/abort"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(response.status).toBe(404);
    expect(mocks.abortTaskIncludingColdGoalLoop).not.toHaveBeenCalled();
  });
});
