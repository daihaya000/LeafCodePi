import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(() => ({ id: "bot-1" })),
  listBotCodeRequests: vi.fn(() => []),
  stopBotCodeRequest: vi.fn(),
  completeBotCodeRequest: vi.fn(),
  abortTaskIncludingColdGoalLoop: vi.fn(),
  peekCodeRequestProgress: vi.fn(async () => ({})),
  jsonError: vi.fn((error: unknown) => ({ error: String(error), status: 500 })),
  localRuntimeBlocked: vi.fn(() => false),
  forwardBotCodeRequestAbort: vi.fn(),
}));

vi.mock("@/lib/bots", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/pi/bot-code-relay", () => ({
  listBotCodeRequests: mocks.listBotCodeRequests,
  stopBotCodeRequest: mocks.stopBotCodeRequest,
}));
vi.mock("@/lib/pi/harness", () => ({
  abortTaskIncludingColdGoalLoop: mocks.abortTaskIncludingColdGoalLoop,
  completeBotCodeRequest: mocks.completeBotCodeRequest,
  peekCodeRequestProgress: mocks.peekCodeRequestProgress,
  jsonError: mocks.jsonError,
}));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => ({
  forwardBotCodeRequestAbort: mocks.forwardBotCodeRequestAbort,
  forwardTaskAbort: vi.fn(),
  forwardTaskDetail: vi.fn(),
  forwardTaskPrompt: vi.fn(),
  forwardPermissionAnswer: vi.fn(),
  forwardQuestionAnswer: vi.fn(),
  forwardTaskPendingRequests: vi.fn(),
  forwardPendingRequestsByTask: vi.fn(),
  needsLocalResolution: vi.fn(() => false),
  forwardablePromptBody: vi.fn((body) => body),
}));

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/bots/bot-1/code-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "bot-1" }) };

describe("POST /api/bots/[id]/code-requests", () => {
  beforeEach(() => {
    mocks.localRuntimeBlocked.mockReset();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.stopBotCodeRequest.mockReset();
    mocks.stopBotCodeRequest.mockResolvedValue({ state: "cancelled", codeTaskId: "task-1" });
    mocks.abortTaskIncludingColdGoalLoop.mockReset();
    mocks.abortTaskIncludingColdGoalLoop.mockResolvedValue({ id: "task-1", status: "error" });
    mocks.completeBotCodeRequest.mockReset();
    mocks.forwardBotCodeRequestAbort.mockReset();
  });

  it("stops the request in this process while it owns the outbox", async () => {
    const response = await POST(request({ action: "abort", requestId: "req-1" }), params);
    expect(response.status).toBe(200);
    expect(mocks.stopBotCodeRequest).toHaveBeenCalledWith("bot-1", "req-1");
    expect(mocks.forwardBotCodeRequestAbort).not.toHaveBeenCalled();
  });

  it("forwards the stop to the owning Backend after the cutover", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardBotCodeRequestAbort.mockResolvedValue({
      ok: true,
      result: { requestId: "req-1", state: "cancelled", task: { id: "task-1" } },
    });
    const response = await POST(request({ action: "abort", requestId: "req-1" }), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ requestId: "req-1", state: "cancelled", task: { id: "task-1" } });
    expect(mocks.forwardBotCodeRequestAbort).toHaveBeenCalledWith("bot-1", "req-1");
    expect(mocks.stopBotCodeRequest).not.toHaveBeenCalled();
    expect(mocks.completeBotCodeRequest).not.toHaveBeenCalled();
  });

  it("never stops the request locally when the Backend cannot take it", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardBotCodeRequestAbort.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    expect((await POST(request({ action: "abort", requestId: "req-1" }), params)).status).toBe(404);
    mocks.forwardBotCodeRequestAbort.mockResolvedValue({ ok: false, reason: "unreachable" });
    const failed = await POST(request({ action: "abort", requestId: "req-1" }), params);
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "Backendを停止できません", code: "BACKEND_FORWARD_FAILED", reason: "unreachable" });
    expect(mocks.stopBotCodeRequest).not.toHaveBeenCalled();
  });
});
