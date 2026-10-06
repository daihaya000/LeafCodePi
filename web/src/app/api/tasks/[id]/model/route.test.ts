import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setTaskModel: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  forwardTaskModel: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
  clearGoalLoopAutoModel: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);
vi.mock("@/lib/pi/goal-loop-auto-model", () => ({ clearGoalLoopAutoModel: mocks.clearGoalLoopAutoModel }));
vi.mock("@/lib/backend-forward", () => ({ forwardTaskModel: mocks.forwardTaskModel }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1/model", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[id]/model", () => {
  beforeEach(() => {
    mocks.setTaskModel.mockReset();
    mocks.setTaskModel.mockResolvedValue({ id: "task-1" });
    mocks.forwardTaskModel.mockReset();
    mocks.forwardTaskModel.mockResolvedValue({ ok: true, task: { id: "task-1", modelID: "chosen" } });
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.clearGoalLoopAutoModel.mockReset();
  });

  it("drops a running Goal Loop's Auto-per-turn marker once a concrete model is set", async () => {
    await POST(request({ model: "chosen" }), { params: Promise.resolve({ id: "task-1" }) });
    expect(mocks.clearGoalLoopAutoModel).toHaveBeenCalledWith("task-1");
    mocks.clearGoalLoopAutoModel.mockReset();
    mocks.setTaskModel.mockRejectedValue(new Error("fail"));
    await POST(request({ model: "chosen" }), { params: Promise.resolve({ id: "task-1" }) });
    expect(mocks.clearGoalLoopAutoModel).not.toHaveBeenCalled();
  });

  it("rejects a non-string model before calling the harness", async () => {
    const response = await POST(
      request({ model: 123 }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.setTaskModel).not.toHaveBeenCalled();
  });

  it("forwards the change after the cutover without touching the local session", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);

    const response = await POST(
      request({ model: "chosen" }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task: { id: "task-1", modelID: "chosen" } });
    expect(mocks.forwardTaskModel).toHaveBeenCalledWith("task-1", "chosen");
    expect(mocks.setTaskModel).not.toHaveBeenCalled();
  });

  it("reports a forwarded failure with its status", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskModel.mockResolvedValue({ ok: false, reason: "incompatible", status: 409 });

    const refused = await POST(request({ model: "chosen" }), { params: Promise.resolve({ id: "task-1" }) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "モデルの変更に失敗しました" });

    mocks.forwardTaskModel.mockResolvedValue({ ok: false, reason: "unreachable" });
    expect((await POST(request({ model: "chosen" }), { params: Promise.resolve({ id: "task-1" }) })).status).toBe(502);
    expect(mocks.setTaskModel).not.toHaveBeenCalled();
  });
});
