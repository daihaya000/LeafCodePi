import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  promoteTask: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => mocks);

const owner = vi.hoisted(() => ({
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskAdmin: vi.fn(),
}));
vi.mock("@/lib/pi/runtime-ownership", () => ({ localRuntimeBlocked: owner.localRuntimeBlocked }));
vi.mock("@/lib/backend-forward", () => ({ forwardTaskAdmin: owner.forwardTaskAdmin }));

import { POST } from "./route";

describe("POST /api/tasks/[id]/promote", () => {
  beforeEach(() => {
    mocks.promoteTask.mockReset();
    owner.localRuntimeBlocked.mockReturnValue(false);
    owner.forwardTaskAdmin.mockReset();
  });

  it("hands the promotion to the owning Backend and replays its answer", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    owner.forwardTaskAdmin.mockResolvedValueOnce({ ok: true, status: 409, body: { error: "移動先が使われています" } });
    const request = () => new NextRequest("http://localhost/api/tasks/task-1/promote", {
      method: "POST",
      body: JSON.stringify({ destinationPath: "C:\\work\\project" }),
    });
    const refused = await POST(request(), { params: Promise.resolve({ id: "task-1" }) });
    expect(owner.forwardTaskAdmin).toHaveBeenCalledWith("task-1", { action: "promote", destinationPath: "C:\\work\\project" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "移動先が使われています" });
    owner.forwardTaskAdmin.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    expect((await POST(request(), { params: Promise.resolve({ id: "task-1" }) })).status).toBe(502);
    expect(mocks.promoteTask).not.toHaveBeenCalled();
  });

  it("passes the selected destination to the promotion service", async () => {
    const result = { task: { id: "task-1" }, project: { id: "project-1" } };
    mocks.promoteTask.mockResolvedValue(result);

    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/promote", {
        method: "POST",
        body: JSON.stringify({ destinationPath: "C:\\work\\project" }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.promoteTask).toHaveBeenCalledWith("task-1", "C:\\work\\project");
    expect(await response.json()).toEqual(result);
  });

  it("rejects an empty destination", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/promote", {
        method: "POST",
        body: JSON.stringify({ destinationPath: "  " }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.promoteTask).not.toHaveBeenCalled();
  });
});
