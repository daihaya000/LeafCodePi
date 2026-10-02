import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unrevertTask: vi.fn(),
  forwardTaskUnrevert: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
}));

vi.mock("@/lib/pi/harness", () => ({
  unrevertTask: mocks.unrevertTask,
  jsonError: (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500,
  }),
}));
vi.mock("@/lib/backend-forward", () => ({ forwardTaskUnrevert: mocks.forwardTaskUnrevert }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "task-1" }) };
const request = () => new NextRequest("http://localhost/api/tasks/task-1/unrevert", { method: "POST" });

describe("POST /api/tasks/[id]/unrevert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.unrevertTask.mockResolvedValue({ id: "task-1", revertLeafId: null });
    mocks.forwardTaskUnrevert.mockResolvedValue({ ok: true, task: { id: "task-1", revertLeafId: null } });
  });

  it("restores locally while this process owns the runtime", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "task-1", revertLeafId: null } });
    expect(mocks.unrevertTask).toHaveBeenCalledWith("task-1");
    expect(mocks.forwardTaskUnrevert).not.toHaveBeenCalled();
  });

  it("forwards the restore after the cutover and does not edit the session here", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "task-1", revertLeafId: null } });
    expect(mocks.forwardTaskUnrevert).toHaveBeenCalledWith("task-1");
    expect(mocks.unrevertTask).not.toHaveBeenCalled();
  });

  it("reports a forwarded failure with its status", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskUnrevert.mockResolvedValue({ ok: false, reason: "incompatible", status: 409 });
    const refused = await POST(request(), params);
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toEqual({
      error: "応答中は巻き戻せません。停止してからお試しください",
    });
    mocks.forwardTaskUnrevert.mockResolvedValue({ ok: false, reason: "unreachable" });
    expect((await POST(request(), params)).status).toBe(502);
    expect(mocks.unrevertTask).not.toHaveBeenCalled();
  });
});
