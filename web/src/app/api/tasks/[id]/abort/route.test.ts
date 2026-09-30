import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  botIdForCodeTask: vi.fn(),
  abortTaskIncludingColdGoalLoop: vi.fn(),
  stopBotCodeTask: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskAbort: vi.fn(),
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
    mocks.localRuntimeBlocked.mockReturnValue(false);
  });

  it("forwards the abort to the owning Backend after the cutover", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskAbort.mockResolvedValue({ ok: true, task: { id: "code-1", status: "error" } });
    const response = await POST(request(), { params: Promise.resolve({ id: "code-1" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "code-1", status: "error" } });
    expect(mocks.abortTaskIncludingColdGoalLoop).not.toHaveBeenCalled();
    expect(mocks.stopBotCodeTask).not.toHaveBeenCalled();
  });

  it("keeps the Bot-owned outbox path in the forwarded request", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.botIdForCodeTask.mockReturnValue("bot-1");
    mocks.forwardTaskAbort.mockResolvedValue({ ok: true, task: { id: "code-1", status: "error" } });
    await POST(request(), { params: Promise.resolve({ id: "code-1" }) });
    expect(mocks.forwardTaskAbort).toHaveBeenCalledWith("code-1", { botId: "bot-1" });
  });

  it("never aborts locally when the Backend cannot take it", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskAbort.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    expect((await POST(request(), { params: Promise.resolve({ id: "code-1" }) })).status).toBe(404);
    mocks.forwardTaskAbort.mockResolvedValue({ ok: false, reason: "unreachable" });
    const failed = await POST(request(), { params: Promise.resolve({ id: "code-1" }) });
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "Backendを停止できません", code: "BACKEND_FORWARD_FAILED", reason: "unreachable" });
    expect(mocks.abortTaskIncludingColdGoalLoop).not.toHaveBeenCalled();
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
