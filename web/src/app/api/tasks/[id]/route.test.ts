import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTaskDetailBounded: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskDetail: vi.fn(),
}));
vi.mock("@/lib/pi/get-task-detail-bounded", () => ({ getTaskDetailBounded: mocks.getTaskDetailBounded }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => ({
  forwardTaskDetail: mocks.forwardTaskDetail,
  forwardTaskPrompt: vi.fn(),
  needsLocalResolution: vi.fn(() => false),
  forwardablePromptBody: vi.fn((body) => body),
}));
vi.mock("@/lib/pi/harness", () => ({
  archiveTask: vi.fn(),
  destroyTask: vi.fn(),
  restoreTask: vi.fn(),
  jsonError: (error: unknown) => ({ error: String(error), status: 500 }),
}));

import { GET } from "./route";

function request(): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1", { method: "GET" });
}

const params = { params: Promise.resolve({ id: "task-1" }) };

describe("GET /api/tasks/[id]", () => {
  beforeEach(() => {
    mocks.getTaskDetailBounded.mockReset();
    mocks.getTaskDetailBounded.mockResolvedValue({ id: "task-1", status: "idle" });
    mocks.localRuntimeBlocked.mockReset();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.forwardTaskDetail.mockReset();
  });

  it("reads the session in this process while it owns the runtime", async () => {
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "task-1", status: "idle" } });
    expect(mocks.forwardTaskDetail).not.toHaveBeenCalled();
  });

  it("reads the detail from the owning Backend after the cutover", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { id: "task-1", status: "working", live: true } });
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "task-1", status: "working", live: true } });
    expect(mocks.forwardTaskDetail).toHaveBeenCalledWith("task-1");
    expect(mocks.getTaskDetailBounded).not.toHaveBeenCalled();
  });

  it("never falls back to the local read when the Backend cannot answer", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "timeout" });
    const failed = await GET(request(), params);
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "Backendから取得できません", code: "BACKEND_FORWARD_FAILED", reason: "timeout" });
    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "not-configured" });
    const unconfigured = await GET(request(), params);
    expect(unconfigured.status).toBe(409);
    await expect(unconfigured.json()).resolves.toEqual({ error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" });
    expect(mocks.getTaskDetailBounded).not.toHaveBeenCalled();
  });
});
