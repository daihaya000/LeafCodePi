import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revertTask: vi.fn(),
  forwardTaskRevert: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
}));

vi.mock("@/lib/pi/harness", () => ({
  revertTask: mocks.revertTask,
  jsonError: (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500,
  }),
}));
vi.mock("@/lib/backend-forward", () => ({ forwardTaskRevert: mocks.forwardTaskRevert }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "task-1" }) };
const request = (body?: unknown) => new NextRequest("http://localhost/api/tasks/task-1/revert", {
  method: "POST",
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("POST /api/tasks/[id]/revert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.revertTask.mockResolvedValue({ task: { id: "task-1" }, text: "戻した", images: [], files: [] });
    mocks.forwardTaskRevert.mockResolvedValue({
      ok: true,
      result: { task: { id: "task-1" }, text: "戻した", images: [], files: [] },
    });
  });

  it("rewinds locally while this process owns the runtime", async () => {
    const response = await POST(request({ entryId: "entry-1" }), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ text: "戻した" });
    expect(mocks.revertTask).toHaveBeenCalledWith("task-1", "entry-1");
    expect(mocks.forwardTaskRevert).not.toHaveBeenCalled();
  });

  it("forwards the rewind after the cutover and does not edit the session here", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    const response = await POST(request({ entryId: "entry-1" }), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ text: "戻した" });
    expect(mocks.forwardTaskRevert).toHaveBeenCalledWith("task-1", "entry-1");
    expect(mocks.revertTask).not.toHaveBeenCalled();
  });

  it("requires an entry id and reports a forwarded failure with its status", async () => {
    expect((await POST(request({}), params)).status).toBe(400);
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskRevert.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    const missing = await POST(request({ entryId: "entry-1" }), params);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "巻き戻しに失敗しました" });
    mocks.forwardTaskRevert.mockResolvedValue({
      ok: false,
      reason: "bad-response",
      status: 409,
      error: "セッションの操作中です。完了してから再試行してください",
    });
    const busy = await POST(request({ entryId: "entry-1" }), params);
    expect(busy.status).toBe(409);
    await expect(busy.json()).resolves.toEqual({
      error: "セッションの操作中です。完了してから再試行してください",
    });
    mocks.forwardTaskRevert.mockResolvedValue({ ok: false, reason: "unreachable" });
    expect((await POST(request({ entryId: "entry-1" }), params)).status).toBe(502);
    expect(mocks.revertTask).not.toHaveBeenCalled();
  });
});
