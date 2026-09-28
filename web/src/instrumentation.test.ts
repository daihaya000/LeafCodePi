import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ relay: vi.fn(), scheduler: vi.fn(), reconcileTasks: vi.fn(), reconcileRooms: vi.fn(), prewarmTasks: vi.fn(() => Promise.resolve([])), warmModels: vi.fn(() => Promise.resolve([])), listAccounts: vi.fn(() => []), backfillLabels: vi.fn(() => Promise.resolve(0)), promptTask: vi.fn(() => Promise.resolve({})), setOrphanListener: vi.fn(), handleOrphans: vi.fn(), order: [] as string[] }));
vi.mock("@/lib/pi/harness", () => ({ startBotCodeRelay: state.relay, getTaskSummariesWithTodoProgress: state.prewarmTasks, listModelsForAccounts: state.warmModels, promptTask: state.promptTask }));
vi.mock("@/lib/accounts", () => ({ listAccounts: state.listAccounts }));
vi.mock("@/lib/routines", () => ({ ensureRoutineScheduler: state.scheduler }));
vi.mock("@/lib/task-runtime-lease", () => ({ reconcileOrphanedWorkingTasks: state.reconcileTasks, setOrphanedTaskListener: state.setOrphanListener }));
vi.mock("@/lib/room-runtime", () => ({ reconcileRoomRuntime: state.reconcileRooms }));
vi.mock("@/lib/direct-title", () => ({ backfillMissingTaskLabels: state.backfillLabels }));
vi.mock("@/lib/pi/restart-resume", () => ({ handleOrphanedTasks: state.handleOrphans }));
vi.mock("@/lib/store", () => ({ getTask: vi.fn() }));
vi.mock("@/lib/pi/goal-loop-state", () => ({ isGoalLoopSessionOwned: vi.fn(() => false), readGoalLoopState: vi.fn(() => null) }));
vi.mock("@/lib/pi/bot-code-relay", () => ({ isRoomDelegatedCodeTask: vi.fn(() => false) }));

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
    state.backfillLabels.mockClear();
    state.promptTask.mockClear();
    state.setOrphanListener.mockReset();
    state.handleOrphans.mockReset();
    state.order.length = 0;
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

  it("registers restart resume before reconciling and resumes with the task's own settings", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    state.setOrphanListener.mockImplementation(() => { state.order.push("listener"); });
    state.reconcileTasks.mockImplementation(() => { state.order.push("reconcile"); });

    await register();

    expect(state.order).toEqual(["listener", "reconcile"]);
    const listener = state.setOrphanListener.mock.calls[0]?.[0] as (tasks: unknown[]) => void;
    const snapshot = { id: "t1" };
    listener([snapshot]);
    expect(state.handleOrphans).toHaveBeenCalledWith([snapshot], expect.any(Object));
    const deps = state.handleOrphans.mock.calls[0]?.[1] as { promptTask: (id: string, prompt: string) => Promise<unknown> };
    await deps.promptTask("t1", "続行");
    expect(state.promptTask).toHaveBeenCalledWith("t1", "続行", undefined, { resume: true });
  });

  it("backfills missing session labels once startup has settled", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.useFakeTimers();
    try {
      await register();
      expect(state.backfillLabels).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);

      expect(state.backfillLabels).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
    expect(state.backfillLabels).not.toHaveBeenCalled();
    expect(state.setOrphanListener).not.toHaveBeenCalled();
  });
});
