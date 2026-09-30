import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  botTaskId: vi.fn((id: string) => `bot:${id}`),
  abortTaskIncludingColdGoalLoop: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskAbort: vi.fn(),
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
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => ({
  forwardTaskAbort: mocks.forwardTaskAbort,
  forwardTaskDetail: vi.fn(),
  forwardTaskPrompt: vi.fn(),
  forwardPermissionAnswer: vi.fn(),
  forwardQuestionAnswer: vi.fn(),
  needsLocalResolution: vi.fn(() => false),
  forwardablePromptBody: vi.fn((body) => body),
}));

describe("POST /api/bots/[id]/abort", () => {
  beforeEach(() => {
    mocks.getBot.mockReset();
    mocks.botTaskId.mockClear();
    mocks.abortTaskIncludingColdGoalLoop.mockReset();
    mocks.localRuntimeBlocked.mockReset();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.forwardTaskAbort.mockReset();
    mocks.jsonError.mockClear();
  });

  it("forwards the Bot abort to the owning Backend, keeping the Bot-owned path", async () => {
    mocks.getBot.mockReturnValue({ id: "one" });
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskAbort.mockResolvedValue({ ok: true, task: { id: "bot:one", status: "error" } });
    const response = await POST(new NextRequest("http://127.0.0.1/api/bots/one/abort"), {
      params: Promise.resolve({ id: "one" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "bot:one", status: "error" } });
    expect(mocks.forwardTaskAbort).toHaveBeenCalledWith("bot:one", { botId: "one" });
    expect(mocks.abortTaskIncludingColdGoalLoop).not.toHaveBeenCalled();
  });

  it("never aborts locally when the Backend cannot take it", async () => {
    mocks.getBot.mockReturnValue({ id: "one" });
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskAbort.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    expect(
      (
        await POST(new NextRequest("http://127.0.0.1/api/bots/one/abort"), { params: Promise.resolve({ id: "one" }) })
      ).status,
    ).toBe(404);
    mocks.forwardTaskAbort.mockResolvedValue({ ok: false, reason: "unreachable" });
    const failed = await POST(new NextRequest("http://127.0.0.1/api/bots/one/abort"), { params: Promise.resolve({ id: "one" }) });
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "Backendを停止できません", code: "BACKEND_FORWARD_FAILED", reason: "unreachable" });
    expect(mocks.abortTaskIncludingColdGoalLoop).not.toHaveBeenCalled();
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
