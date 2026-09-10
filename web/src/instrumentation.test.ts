import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ relay: vi.fn(), scheduler: vi.fn(), reconcileTasks: vi.fn(), reconcileRooms: vi.fn() }));
vi.mock("@/lib/pi/harness", () => ({ startBotCodeRelay: state.relay }));
vi.mock("@/lib/routines", () => ({ ensureRoutineScheduler: state.scheduler }));
vi.mock("@/lib/task-runtime-lease", () => ({ reconcileOrphanedWorkingTasks: state.reconcileTasks }));
vi.mock("@/lib/room-runtime", () => ({ reconcileRoomRuntime: state.reconcileRooms }));

import { register } from "./instrumentation";

describe("runtime startup", () => {
  beforeEach(() => {
    state.relay.mockReset();
    state.scheduler.mockReset();
    state.reconcileTasks.mockReset();
    state.reconcileRooms.mockReset();
  });

  it("starts the Bot relay and routine scheduler in Node.js", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");

    await register();

    expect(state.reconcileTasks).toHaveBeenCalledOnce();
    expect(state.relay).toHaveBeenCalledOnce();
    expect(state.scheduler).toHaveBeenCalledOnce();
    expect(state.reconcileRooms).toHaveBeenCalledOnce();
  });

  it("does not start server services in the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    await register();

    expect(state.reconcileTasks).not.toHaveBeenCalled();
    expect(state.relay).not.toHaveBeenCalled();
    expect(state.scheduler).not.toHaveBeenCalled();
    expect(state.reconcileRooms).not.toHaveBeenCalled();
  });
});
