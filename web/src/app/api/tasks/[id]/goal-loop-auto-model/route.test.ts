import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  readGoalLoopState: vi.fn(),
  setGoalLoopAutoModel: vi.fn(() => true),
  clearGoalLoopAutoModel: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ getTask: mocks.getTask }));
vi.mock("@/lib/pi/goal-loop-state", () => ({
  readGoalLoopState: mocks.readGoalLoopState,
  isGoalLoopSessionOwned: (loop: { status?: string } | null) => loop?.status === "queued" || loop?.status === "paused",
}));
vi.mock("@/lib/pi/goal-loop-auto-model", () => ({
  setGoalLoopAutoModel: mocks.setGoalLoopAutoModel,
  clearGoalLoopAutoModel: mocks.clearGoalLoopAutoModel,
}));

import { PUT } from "./route";

const params = { params: Promise.resolve({ id: "task-1" }) };

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1/goal-loop-auto-model", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/tasks/[id]/goal-loop-auto-model", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.getTask.mockReturnValue({ id: "task-1", directory: "/work", sessionId: "s1" });
    mocks.readGoalLoopState.mockReturnValue({ status: "queued", createdAt: "t0" });
    mocks.setGoalLoopAutoModel.mockReturnValue(true);
  });

  it("rejects a body without a boolean enabled", async () => {
    expect((await PUT(request({ enabled: "yes" }), params)).status).toBe(400);
    expect(mocks.setGoalLoopAutoModel).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown task", async () => {
    mocks.getTask.mockReturnValue(undefined);
    expect((await PUT(request({ enabled: true }), params)).status).toBe(404);
  });

  it("marks the running loop for per-turn Auto", async () => {
    const response = await PUT(request({ enabled: true }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    expect(mocks.setGoalLoopAutoModel).toHaveBeenCalledWith("task-1", { status: "queued", createdAt: "t0" });
  });

  it("refuses to enable when no Goal Loop owns the session", async () => {
    mocks.readGoalLoopState.mockReturnValue({ status: "completed", createdAt: "t0" });
    expect((await PUT(request({ enabled: true }), params)).status).toBe(409);
    mocks.readGoalLoopState.mockReturnValue(null);
    expect((await PUT(request({ enabled: true }), params)).status).toBe(409);
    expect(mocks.setGoalLoopAutoModel).not.toHaveBeenCalled();
  });

  it("clears the marker even when the loop has already ended", async () => {
    mocks.readGoalLoopState.mockReturnValue(null);
    const response = await PUT(request({ enabled: false }), params);
    expect(response.status).toBe(200);
    expect(mocks.clearGoalLoopAutoModel).toHaveBeenCalledWith("task-1");
  });
});
