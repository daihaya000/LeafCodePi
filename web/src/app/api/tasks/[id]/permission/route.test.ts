import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  respondToPermissionPrompt: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({ error: String(error), status: 500 })),
  localRuntimeBlocked: vi.fn(() => false),
  forwardPermissionAnswer: vi.fn(),
}));
vi.mock("@/lib/pi/harness", () => ({
  respondToPermissionPrompt: mocks.respondToPermissionPrompt,
  jsonError: mocks.jsonError,
}));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => ({
  forwardPermissionAnswer: mocks.forwardPermissionAnswer,
  forwardTaskDetail: vi.fn(),
  forwardTaskPrompt: vi.fn(),
  needsLocalResolution: vi.fn(() => false),
  forwardablePromptBody: vi.fn((body) => body),
}));

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1/permission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "task-1" }) };

describe("POST /api/tasks/[id]/permission", () => {
  beforeEach(() => {
    mocks.respondToPermissionPrompt.mockReset();
    mocks.localRuntimeBlocked.mockReset();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.forwardPermissionAnswer.mockReset();
  });

  it("answers in this process while it owns the runtime", async () => {
    mocks.respondToPermissionPrompt.mockReturnValue(true);
    const response = await POST(request({ requestId: "req-1", approved: true }), params);
    expect(response.status).toBe(200);
    expect(mocks.respondToPermissionPrompt).toHaveBeenCalledWith("task-1", "req-1", true);
    expect(mocks.forwardPermissionAnswer).not.toHaveBeenCalled();
  });

  it("forwards the answer to the owning Backend after the cutover", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardPermissionAnswer.mockResolvedValue({ ok: true });
    const response = await POST(request({ requestId: "req-1", approved: false }), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.forwardPermissionAnswer).toHaveBeenCalledWith("task-1", { requestId: "req-1", approved: false });
    expect(mocks.respondToPermissionPrompt).not.toHaveBeenCalled();
  });

  it("maps a request that is no longer pending to 404 and never answers locally", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardPermissionAnswer.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    const stale = await POST(request({ requestId: "req-1", approved: true }), params);
    expect(stale.status).toBe(404);
    mocks.forwardPermissionAnswer.mockResolvedValue({ ok: false, reason: "timeout" });
    const failed = await POST(request({ requestId: "req-1", approved: true }), params);
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "Backendへ回答できません", code: "BACKEND_FORWARD_FAILED", reason: "timeout" });
    expect(mocks.respondToPermissionPrompt).not.toHaveBeenCalled();
  });

  it("validates the body before forwarding", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    expect((await POST(request({ approved: true }), params)).status).toBe(400);
    expect((await POST(request({ requestId: "req-1" }), params)).status).toBe(400);
    expect(mocks.forwardPermissionAnswer).not.toHaveBeenCalled();
  });

  it("rejects a non-string request id before responding", async () => {
    const response = await POST(request({ requestId: 123, approved: true }), params);
    expect(response.status).toBe(400);
    expect(mocks.respondToPermissionPrompt).not.toHaveBeenCalled();
    expect(mocks.forwardPermissionAnswer).not.toHaveBeenCalled();
  });
});
