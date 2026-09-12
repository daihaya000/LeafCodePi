import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ relay: vi.fn(), scheduler: vi.fn(), reconcileTasks: vi.fn(), reconcileRooms: vi.fn(), prewarmTasks: vi.fn(() => Promise.resolve([])), warmModels: vi.fn(() => Promise.resolve([])), listAccounts: vi.fn(() => []) }));
vi.mock("@/lib/pi/harness", () => ({ startBotCodeRelay: state.relay, getTaskSummariesWithTodoProgress: state.prewarmTasks, listModelsForAccounts: state.warmModels }));
vi.mock("@/lib/accounts", () => ({ listAccounts: state.listAccounts }));
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
    state.prewarmTasks.mockClear();
    state.warmModels.mockClear();
    state.listAccounts.mockClear();
  });

  it("starts the Bot relay and routine scheduler in Node.js", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");

    await register();

    expect(state.reconcileTasks).toHaveBeenCalledOnce();
    expect(state.relay).toHaveBeenCalledOnce();
    expect(state.scheduler).toHaveBeenCalledOnce();
    expect(state.reconcileRooms).toHaveBeenCalledOnce();
    expect(state.prewarmTasks).toHaveBeenCalledWith(true);
    expect(state.listAccounts).toHaveBeenCalledOnce();
    expect(state.warmModels).toHaveBeenCalledOnce();
  });

  it("does not start server services in the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    await register();

    expect(state.reconcileTasks).not.toHaveBeenCalled();
    expect(state.relay).not.toHaveBeenCalled();
    expect(state.scheduler).not.toHaveBeenCalled();
    expect(state.reconcileRooms).not.toHaveBeenCalled();
    expect(state.prewarmTasks).not.toHaveBeenCalled();
    expect(state.warmModels).not.toHaveBeenCalled();
  });
});
