import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abortTaskCompaction: vi.fn(),
  forwardTaskCompactAbort: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
}));

vi.mock("@/lib/pi/harness", () => ({
  abortTaskCompaction: mocks.abortTaskCompaction,
  jsonError: (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500,
  }),
}));
vi.mock("@/lib/backend-forward", () => ({ forwardTaskCompactAbort: mocks.forwardTaskCompactAbort }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "task-1" }) };
const request = () => new NextRequest("http://localhost/api/tasks/task-1/compact/abort", { method: "POST" });

describe("POST /api/tasks/[id]/compact/abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.abortTaskCompaction.mockResolvedValue({ id: "task-1", isCompacting: false });
    mocks.forwardTaskCompactAbort.mockResolvedValue({ ok: true, task: { id: "task-1", isCompacting: false } });
  });

  it("stops the compaction locally while this process owns the runtime", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "task-1", isCompacting: false } });
    expect(mocks.abortTaskCompaction).toHaveBeenCalledWith("task-1");
    expect(mocks.forwardTaskCompactAbort).not.toHaveBeenCalled();
  });

  it("forwards the stop after the cutover", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "task-1", isCompacting: false } });
    expect(mocks.forwardTaskCompactAbort).toHaveBeenCalledWith("task-1");
    expect(mocks.abortTaskCompaction).not.toHaveBeenCalled();
  });

  it("reports a forwarded failure with its status", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskCompactAbort.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    const missing = await POST(request(), params);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "圧縮の停止に失敗しました" });
    mocks.forwardTaskCompactAbort.mockResolvedValue({ ok: false, reason: "unreachable" });
    expect((await POST(request(), params)).status).toBe(502);
    expect(mocks.abortTaskCompaction).not.toHaveBeenCalled();
  });
});
