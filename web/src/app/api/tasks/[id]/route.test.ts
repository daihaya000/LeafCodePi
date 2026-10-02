import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTaskDetailBounded: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
  forwardTaskDetail: vi.fn(),
  forwardTaskTeardown: vi.fn(),
  archiveTask: vi.fn(),
  destroyTask: vi.fn(),
}));
vi.mock("@/lib/pi/get-task-detail-bounded", () => ({ getTaskDetailBounded: mocks.getTaskDetailBounded }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => ({
  forwardTaskDetail: mocks.forwardTaskDetail,
  forwardTaskTeardown: mocks.forwardTaskTeardown,
  forwardTaskPrompt: vi.fn(),
  needsLocalResolution: vi.fn(() => false),
  forwardablePromptBody: vi.fn((body) => body),
}));
vi.mock("@/lib/pi/harness", () => ({
  archiveTask: mocks.archiveTask,
  destroyTask: mocks.destroyTask,
  restoreTask: vi.fn(),
  jsonError: (error: unknown) => ({ error: String(error), status: 500 }),
}));

import { DELETE, GET } from "./route";

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
    expect(mocks.forwardTaskDetail).toHaveBeenCalledWith("task-1", undefined);
    expect(mocks.getTaskDetailBounded).not.toHaveBeenCalled();
  });

  it("forwards a page/omit messages mode to the owning Backend", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValue({ ok: true, detail: { id: "task-1", status: "idle" } });
    const omit = await GET(
      new NextRequest("http://localhost/api/tasks/task-1?messages=omit", { method: "GET" }),
      params,
    );
    expect(omit.status).toBe(200);
    expect(mocks.forwardTaskDetail).toHaveBeenLastCalledWith("task-1", { messages: "omit" });
    const page = await GET(
      new NextRequest("http://localhost/api/tasks/task-1?messages=page", { method: "GET" }),
      params,
    );
    expect(page.status).toBe(200);
    expect(mocks.forwardTaskDetail).toHaveBeenLastCalledWith("task-1", { messages: "page" });
    // An unknown mode is not a Backend option; keep the plain read.
    await GET(
      new NextRequest("http://localhost/api/tasks/task-1?messages=bogus", { method: "GET" }),
      params,
    );
    expect(mocks.forwardTaskDetail).toHaveBeenLastCalledWith("task-1", undefined);
  });

  it("answers 404 when the owning Backend has no such task", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "not-found", status: 404 });
    const response = await GET(request(), params);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "タスクが見つかりません" });
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

describe("DELETE /api/tasks/[id]", () => {
  const remove = (query = "") =>
    DELETE(new NextRequest(`http://localhost/api/tasks/task-1${query}`, { method: "DELETE" }), params);

  beforeEach(() => {
    mocks.localRuntimeBlocked.mockReset();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    mocks.forwardTaskTeardown.mockReset();
    mocks.archiveTask.mockReset();
    mocks.destroyTask.mockReset();
  });

  it("archives and deletes in this process while it owns the runtime", async () => {
    mocks.archiveTask.mockResolvedValue({ id: "task-1", status: "archived" });
    mocks.destroyTask.mockResolvedValue({ ok: true });
    const archived = await remove();
    await expect(archived.json()).resolves.toEqual({ task: { id: "task-1", status: "archived" } });
    const destroyed = await remove("?hard=1");
    await expect(destroyed.json()).resolves.toEqual({ ok: true });
    expect(mocks.forwardTaskTeardown).not.toHaveBeenCalled();
  });

  it("hands the teardown to the owning Backend, which stops the running session", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskTeardown.mockResolvedValueOnce({ ok: true, result: { id: "task-1", status: "archived" } });
    const archived = await remove();
    expect(mocks.forwardTaskTeardown).toHaveBeenLastCalledWith("task-1", "archive");
    await expect(archived.json()).resolves.toEqual({ task: { id: "task-1", status: "archived" } });
    mocks.forwardTaskTeardown.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const destroyed = await remove("?hard=1");
    expect(mocks.forwardTaskTeardown).toHaveBeenLastCalledWith("task-1", "destroy");
    await expect(destroyed.json()).resolves.toEqual({ ok: true });
    expect(mocks.archiveTask).not.toHaveBeenCalled();
    expect(mocks.destroyTask).not.toHaveBeenCalled();
  });

  it("reports a missing task and a Backend failure without touching the local store", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskTeardown.mockResolvedValueOnce({ ok: false, reason: "not-found", status: 404 });
    expect((await remove()).status).toBe(404);
    mocks.forwardTaskTeardown.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    const failed = await remove("?hard=1");
    expect(failed.status).toBe(502);
    expect(mocks.destroyTask).not.toHaveBeenCalled();
  });
});
