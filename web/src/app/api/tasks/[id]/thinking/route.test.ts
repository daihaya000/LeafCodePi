import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setTaskThinkingLevel: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  forwardTaskThinking: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
}));

vi.mock("@/lib/pi/harness", () => mocks);
vi.mock("@/lib/backend-forward", () => ({ forwardTaskThinking: mocks.forwardTaskThinking }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1/thinking", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[id]/thinking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.setTaskThinkingLevel.mockResolvedValue({ id: "task-1", thinkingLevel: "high" });
    mocks.forwardTaskThinking.mockResolvedValue({ ok: true, task: { id: "task-1", thinkingLevel: "high" } });
  });

  it("changes the level locally while this process owns the runtime", async () => {
    const response = await POST(request({ thinkingLevel: "high" }), { params: Promise.resolve({ id: "task-1" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "task-1", thinkingLevel: "high" } });
    expect(mocks.setTaskThinkingLevel).toHaveBeenCalledWith("task-1", "high");
    expect(mocks.forwardTaskThinking).not.toHaveBeenCalled();
  });

  it("forwards the change after the cutover without touching the local session", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    const response = await POST(request({ thinkingLevel: "high" }), { params: Promise.resolve({ id: "task-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.forwardTaskThinking).toHaveBeenCalledWith("task-1", "high");
    expect(mocks.setTaskThinkingLevel).not.toHaveBeenCalled();
  });

  it("requires a level and reports a forwarded failure with its status", async () => {
    expect((await POST(request({}), { params: Promise.resolve({ id: "task-1" }) })).status).toBe(400);
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskThinking.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    const missing = await POST(request({ thinkingLevel: "high" }), { params: Promise.resolve({ id: "task-1" }) });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "思考レベルの変更に失敗しました" });
    expect(mocks.setTaskThinkingLevel).not.toHaveBeenCalled();
  });
});
