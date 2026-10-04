import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStartup } from "@backend-core/runtime-startup.mjs";

const globals = globalThis as typeof globalThis & { __leafcodeRuntimeStartup?: RuntimeStartup };
afterEach(async () => {
  globals.__leafcodeRuntimeStartup?.cancelWarmups();
  delete globals.__leafcodeRuntimeStartup;
  // Drain already-started mock warmups before resetting the next fixture.
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const state = vi.hoisted(() => ({ relay: vi.fn(), scheduler: vi.fn(), reconcileTasks: vi.fn(), reconcileRooms: vi.fn(), prewarmTasks: vi.fn(() => Promise.resolve([])), warmModels: vi.fn(() => Promise.resolve([])), listAccounts: vi.fn(() => []), backfillLabels: vi.fn(() => Promise.resolve(0)), promptTask: vi.fn(() => Promise.resolve({})), setOrphanListener: vi.fn(), setLeaseLostListener: vi.fn(), abortAfterLeaseLoss: vi.fn(), handleOrphans: vi.fn(), order: [] as string[] }));
vi.mock("@/lib/pi/harness", () => ({ startBotCodeRelay: state.relay, getTaskSummariesWithTodoProgress: state.prewarmTasks, listModelsForAccounts: state.warmModels, promptTask: state.promptTask, abortTaskSessionsAfterLeaseLoss: state.abortAfterLeaseLoss }));
vi.mock("@/lib/accounts", () => ({ listAccounts: state.listAccounts }));
vi.mock("@/lib/routines", () => ({ ensureRoutineScheduler: state.scheduler }));
vi.mock("@/lib/task-runtime-lease", () => ({ reconcileOrphanedWorkingTasks: state.reconcileTasks, setOrphanedTaskListener: state.setOrphanListener, setLeaseLostListener: state.setLeaseLostListener }));
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
    state.setLeaseLostListener.mockReset();
    state.abortAfterLeaseLoss.mockReset();
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
    await vi.waitFor(() => {
      expect(state.listAccounts).toHaveBeenCalledOnce();
      expect(state.warmModels).toHaveBeenCalledOnce();
    });
  });

  it("registers restart resume before reconciling and resumes with the task's own settings", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    state.setLeaseLostListener.mockImplementation(() => { state.order.push("lease-listener"); });
    state.setOrphanListener.mockImplementation(() => { state.order.push("listener"); });
    state.reconcileTasks.mockImplementation(() => { state.order.push("reconcile"); });

    await register();

    expect(state.order).toEqual(["lease-listener", "listener", "reconcile"]);
    const leaseLostListener = state.setLeaseLostListener.mock.calls[0]?.[0] as (taskIds: string[]) => void;
    leaseLostListener(["t1"]);
    expect(state.abortAfterLeaseLoss).toHaveBeenCalledWith(["t1"]);
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

      await vi.advanceTimersByTimeAsync(60_000);

      expect(state.backfillLabels).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares startup across concurrent Node registrations", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await Promise.all([register(), register(), register()]);
    expect(state.setOrphanListener).toHaveBeenCalledOnce();
    expect(state.setLeaseLostListener).toHaveBeenCalledOnce();
    expect(state.reconcileTasks).toHaveBeenCalledOnce();
    expect(state.relay).toHaveBeenCalledOnce();
    expect(state.scheduler).toHaveBeenCalledOnce();
    expect(state.reconcileRooms).toHaveBeenCalledOnce();
  });

  it("retries failed required startup without starting the relay prematurely", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    state.reconcileTasks.mockImplementationOnce(() => { throw new Error("store unavailable"); });
    await register();
    expect(state.relay).not.toHaveBeenCalled();
    expect(state.scheduler).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("[bot-code-relay] startup scan unavailable", expect.any(Error));
    await register();
    expect(state.reconcileTasks).toHaveBeenCalledTimes(2);
    expect(state.relay).toHaveBeenCalledOnce();
    expect(state.scheduler).toHaveBeenCalledOnce();
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
    expect(state.setLeaseLostListener).not.toHaveBeenCalled();
    expect(state.abortAfterLeaseLoss).not.toHaveBeenCalled();
  });
});
