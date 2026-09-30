import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureRoutineScheduler: vi.fn(),
  getRoutine: vi.fn(),
  runRoutine: vi.fn(),
  forwardBotRoutineRun: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
}));

vi.mock("@/lib/routines", () => ({
  ensureRoutineScheduler: mocks.ensureRoutineScheduler,
  getRoutine: mocks.getRoutine,
  runRoutine: mocks.runRoutine,
}));
vi.mock("@/lib/backend-forward", () => ({ forwardBotRoutineRun: mocks.forwardBotRoutineRun }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "bot-1", routineId: "routine-1" }) };
const request = () => new NextRequest("http://localhost/api/bots/bot-1/routines/routine-1/run", { method: "POST" });

describe("POST /api/bots/[id]/routines/[routineId]/run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.getRoutine.mockReturnValue({ id: "routine-1", name: "朝の確認", enabled: true });
    mocks.runRoutine.mockResolvedValue({ id: "routine-1", name: "朝の確認", lastRunAt: "2026-01-01T00:00:00.000Z" });
    mocks.forwardBotRoutineRun.mockResolvedValue({ ok: true, routine: { id: "routine-1", name: "朝の確認" } });
  });

  it("runs the routine locally while this process owns the runtime", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ routine: { id: "routine-1" } });
    expect(mocks.ensureRoutineScheduler).toHaveBeenCalledTimes(1);
    expect(mocks.runRoutine).toHaveBeenCalledWith("bot-1", "routine-1");
    expect(mocks.forwardBotRoutineRun).not.toHaveBeenCalled();
  });

  it("forwards the run after the cutover and does not start the scheduler or the run here", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ routine: { id: "routine-1" } });
    expect(mocks.forwardBotRoutineRun).toHaveBeenCalledWith("bot-1", "routine-1");
    expect(mocks.ensureRoutineScheduler).not.toHaveBeenCalled();
    expect(mocks.runRoutine).not.toHaveBeenCalled();
  });

  it("reports a forwarded failure with its status and the stored routine", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardBotRoutineRun.mockResolvedValue({ ok: false, reason: "timeout" });
    const response = await POST(request(), params);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "ルーティンの実行に失敗しました",
      routine: { id: "routine-1" },
    });
    mocks.forwardBotRoutineRun.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    const missing = await POST(request(), params);
    expect(missing.status).toBe(404);
  });

  it("answers 404 for an unknown routine before either path runs", async () => {
    mocks.getRoutine.mockReturnValue(undefined);
    const response = await POST(request(), params);
    expect(response.status).toBe(404);
    expect(mocks.runRoutine).not.toHaveBeenCalled();
    expect(mocks.forwardBotRoutineRun).not.toHaveBeenCalled();
  });
});
