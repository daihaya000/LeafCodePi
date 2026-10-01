import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ forkTask: vi.fn(), localRuntimeBlocked: vi.fn(() => false), forwardTaskAdmin: vi.fn() }));
vi.mock("@/lib/pi/task-fork", () => ({ forkTask: mocks.forkTask }));
vi.mock("@/lib/pi/harness", () => ({ jsonError: (error: Error & { status?: number }) => ({ error: error.message, status: error.status ?? 500 }) }));
vi.mock("@/lib/pi/runtime-ownership", () => ({ localRuntimeBlocked: mocks.localRuntimeBlocked }));
vi.mock("@/lib/backend-forward", () => ({ forwardTaskAdmin: mocks.forwardTaskAdmin }));
import { POST } from "./route";

const params = { params: Promise.resolve({ id: "task-1" }) };
const request = (body: unknown) => new NextRequest("http://localhost/api/tasks/task-1/fork", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); mocks.localRuntimeBlocked.mockReturnValue(false); });
describe("POST /api/tasks/[id]/fork", () => {
  it.each([null, {}, { entryId: " " }, { entryId: 1 }, []])("rejects invalid input %s", async (body) => {
    expect((await POST(request(body), params)).status).toBe(400);
    expect(mocks.forkTask).not.toHaveBeenCalled();
    expect(mocks.forwardTaskAdmin).not.toHaveBeenCalled();
  });
  it("forks locally only in the owning process", async () => {
    const result = { task: { id: "forked" }, text: "入力", images: [], files: [] };
    mocks.forkTask.mockResolvedValueOnce(result);
    const response = await POST(request({ entryId: " entry-1 " }), params);
    expect(await response.json()).toEqual(result);
    expect(mocks.forkTask).toHaveBeenCalledWith("task-1", "entry-1");
  });
  it("replays owner's success/refusal and never retries locally when transport fails", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    for (const answer of [{ status: 200, body: { task: { id: "forked" }, text: "入力", images: [], files: [] } }, { status: 409, body: { error: "応答中" } }]) {
      mocks.forwardTaskAdmin.mockResolvedValueOnce({ ok: true, ...answer });
      const response = await POST(request({ entryId: "entry-1" }), params);
      expect(response.status).toBe(answer.status);
      expect(await response.json()).toEqual(answer.body);
    }
    mocks.forwardTaskAdmin.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    expect((await POST(request({ entryId: "entry-1" }), params)).status).toBe(502);
    expect(mocks.forwardTaskAdmin).toHaveBeenCalledWith("task-1", { action: "fork", entryId: "entry-1" });
    expect(mocks.forkTask).not.toHaveBeenCalled();
  });
  it("preserves local validation errors", async () => {
    mocks.forkTask.mockRejectedValueOnce(Object.assign(new Error("履歴なし"), { status: 404 }));
    const response = await POST(request({ entryId: "entry-1" }), params);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "履歴なし" });
  });
});
