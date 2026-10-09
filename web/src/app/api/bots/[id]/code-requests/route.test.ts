import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(() => ({ id: "bot-1" })),
  listBotCodeRequests: vi.fn<() => { id: string; codeTaskId: string | null; state: string; prompt: string }[]>(() => []),
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

import { GET, POST } from "@backend-runtime/json-business/handlers/bots/[id]/code-requests/route";
beforeEach(()=>{vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME","attach");});

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/bots/bot-1/code-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "bot-1" }) };

describe("GET /api/bots/[id]/code-requests", () => {
  it("returns 304 with no body when the polled request list is unchanged", async () => {
    mocks.listBotCodeRequests.mockReturnValue([
      { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", codeTaskId: null, state: "running", prompt: "run" },
    ]);
    const url = "http://localhost/api/bots/bot-1/code-requests";
    const first = await GET(new NextRequest(url), params);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      requests: [{ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", codeTaskId: null, state: "running", prompt: "run" }],
    });
    const etag = first.headers.get("etag");
    expect(etag?.startsWith("W/")).toBe(true);

    const second = await GET(new NextRequest(url, { headers: { "if-none-match": etag! } }), params);
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(mocks.listBotCodeRequests).toHaveBeenCalledTimes(2);
  });
});

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
    const response = await POST(request({ action: "abort", requestId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), params);
    expect(response.status).toBe(200);
    expect(mocks.stopBotCodeRequest).toHaveBeenCalledWith("bot-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(mocks.forwardBotCodeRequestAbort).not.toHaveBeenCalled();
  });

  it("rejects unsafe request IDs without touching outbox",async()=>{mocks.stopBotCodeRequest.mockClear();for(const requestId of ["../x","bad",null])expect((await POST(request({action:"abort",requestId}),params)).status).toBe(400);expect(mocks.stopBotCodeRequest).not.toHaveBeenCalled();});
});
