import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  handoffTaskToBot: vi.fn(),
  releaseTaskFromBot: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);

const owner = vi.hoisted(() => ({
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskAdmin: vi.fn(),
}));
vi.mock("@/lib/pi/runtime-ownership", () => ({ localRuntimeBlocked: owner.localRuntimeBlocked }));
vi.mock("@/lib/backend-forward", () => ({ forwardTaskAdmin: owner.forwardTaskAdmin }));

describe("POST /api/tasks/[id]/supervisor", () => {
  beforeEach(() => {
    mocks.jsonError.mockClear();
    mocks.handoffTaskToBot.mockReset();
    mocks.releaseTaskFromBot.mockReset();
    owner.localRuntimeBlocked.mockReturnValue(false);
    owner.forwardTaskAdmin.mockReset();
  });

  it("hands a hand-off or release to the owning Backend and never rewires locally", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    const post = (body: unknown) => POST(
      new NextRequest("http://localhost/api/tasks/task-1/supervisor", { method: "POST", body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    owner.forwardTaskAdmin.mockResolvedValueOnce({ ok: true, status: 200, body: { task: { id: "task-1" } } });
    expect(await (await post({ botId: "bot-1" })).json()).toEqual({ task: { id: "task-1" } });
    expect(owner.forwardTaskAdmin).toHaveBeenLastCalledWith("task-1", { action: "handoff", botId: "bot-1" });
    owner.forwardTaskAdmin.mockResolvedValueOnce({ ok: true, status: 200, body: { task: { id: "task-1" } } });
    await post({ botId: null });
    expect(owner.forwardTaskAdmin).toHaveBeenLastCalledWith("task-1", { action: "release" });
    expect((await post({})).status).toBe(400);
    owner.forwardTaskAdmin.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    expect((await post({ botId: "bot-1" })).status).toBe(502);
    expect(mocks.handoffTaskToBot).not.toHaveBeenCalled();
    expect(mocks.releaseTaskFromBot).not.toHaveBeenCalled();
  });

  it("passes the selected Bot and task to the runtime", async () => {
    const task = { id: "task-1", supervisorBotId: "bot-1" };
    mocks.handoffTaskToBot.mockResolvedValue(task);

    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/supervisor", {
        method: "POST",
        body: JSON.stringify({ botId: "bot-1" }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.handoffTaskToBot).toHaveBeenCalledWith("bot-1", "task-1");
    expect(await response.json()).toEqual({ task });
  });

  it("releases the task to user ownership when Bot id is null", async () => {
    const task = { id: "task-1", supervisorBotId: null };
    mocks.releaseTaskFromBot.mockResolvedValue(task);

    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/supervisor", {
        method: "POST",
        body: JSON.stringify({ botId: null }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.releaseTaskFromBot).toHaveBeenCalledWith("task-1");
    expect(mocks.handoffTaskToBot).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ task });
  });

  it("rejects a blank Bot id", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/supervisor", {
        method: "POST",
        body: JSON.stringify({ botId: "  " }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.handoffTaskToBot).not.toHaveBeenCalled();
  });
});
