import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ blocked: vi.fn(), local: vi.fn(), remote: vi.fn() }));
vi.mock("@/lib/pi/harness", () => ({ activeGoalLoopTaskIds: mocks.local }));
vi.mock("@/lib/pi/runtime-ownership", () => ({ localRuntimeBlocked: mocks.blocked }));
vi.mock("@/lib/backend-client", () => ({ readBackendRuntimeState: mocks.remote }));
import { GET } from "./route";
beforeEach(() => { vi.clearAllMocks(); mocks.blocked.mockReturnValue(true); mocks.local.mockReturnValue([]); });
it("uses the Backend even when this client's session map is empty", async () => {
  mocks.remote.mockResolvedValue({ ok: true, body: { taskIds: ["owner-loop"] } });
  expect(await (await GET()).json()).toEqual({ active: 1, taskIds: ["owner-loop"] });
  expect(mocks.local).not.toHaveBeenCalled();
});
it("does not disguise owner failure as an empty running list", async () => {
  mocks.remote.mockResolvedValue({ ok: false, reason: "unreachable" });
  expect((await GET()).status).toBe(503);
});
it("retains standalone development behavior", async () => {
  mocks.blocked.mockReturnValue(false); mocks.local.mockReturnValue(["local-loop"]);
  expect(await (await GET()).json()).toEqual({ active: 1, taskIds: ["local-loop"] });
});
it("returns every local loop and an empty local list when none are running", async () => {
  mocks.blocked.mockReturnValue(false);
  mocks.local.mockReturnValue(["task-1", "task-2"]);
  expect(await (await GET()).json()).toEqual({ active: 2, taskIds: ["task-1", "task-2"] });
  mocks.local.mockReturnValue([]);
  expect(await (await GET()).json()).toEqual({ active: 0, taskIds: [] });
});
