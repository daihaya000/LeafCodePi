import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startBotCodeRelay: vi.fn(),
  reconcileOrphanedWorkingTasks: vi.fn(),
  ensureRoutineScheduler: vi.fn(),
  reconcileRoomRuntime: vi.fn(),
  setLeaseLostListener: vi.fn(),
  setOrphanedTaskListener: vi.fn(),
  abortTaskSessionsAfterLeaseLoss: vi.fn(),
  promptTask: vi.fn(),
  goalLoopCommand: vi.fn(),
  handleOrphanedTasks: vi.fn(),
  getTask: vi.fn(),
  readGoalLoopState: vi.fn(),
  isGoalLoopSessionOwned: vi.fn(),
  isGoalLoopRestartResumable: vi.fn(),
  isRoomDelegatedCodeTask: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
}));

vi.mock("@/lib/pi/harness", () => ({
  startBotCodeRelay: mocks.startBotCodeRelay,
  promptTask: mocks.promptTask,
  goalLoopCommand: mocks.goalLoopCommand,
  abortTaskSessionsAfterLeaseLoss: mocks.abortTaskSessionsAfterLeaseLoss,
  // Left out on purpose: the optional warmups are skipped instead of importing their modules here.
  getTaskSummariesWithTodoProgress: undefined,
  listModelsForAccounts: undefined,
}));
vi.mock("@/lib/routines", () => ({ ensureRoutineScheduler: mocks.ensureRoutineScheduler }));
vi.mock("@/lib/task-runtime-lease", () => ({
  reconcileOrphanedWorkingTasks: mocks.reconcileOrphanedWorkingTasks,
  setLeaseLostListener: mocks.setLeaseLostListener,
  setOrphanedTaskListener: mocks.setOrphanedTaskListener,
}));
vi.mock("@/lib/room-runtime", () => ({ reconcileRoomRuntime: mocks.reconcileRoomRuntime }));
vi.mock("@/lib/pi/restart-resume", () => ({
  handleOrphanedTasks: mocks.handleOrphanedTasks,
  isGoalLoopRestartResumable: mocks.isGoalLoopRestartResumable,
}));
vi.mock("@/lib/store", () => ({ getTask: mocks.getTask }));
vi.mock("@/lib/pi/goal-loop-state", () => ({
  isGoalLoopSessionOwned: mocks.isGoalLoopSessionOwned,
  readGoalLoopState: mocks.readGoalLoopState,
}));
vi.mock("@/lib/pi/bot-code-relay", () => ({ isRoomDelegatedCodeTask: mocks.isRoomDelegatedCodeTask }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));

import { startRuntimeServices } from "./runtime-startup";

const globals = globalThis as typeof globalThis & { __leafcodeRuntimeStartup?: unknown };

describe("startRuntimeServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.localRuntimeBlocked.mockReturnValue(false);
    // The singleton is cached on globalThis so Next route bundles share one startup.
    globals.__leafcodeRuntimeStartup = undefined;
  });
  afterEach(() => {
    globals.__leafcodeRuntimeStartup = undefined;
  });

  it("starts every owner-only service while this process owns the runtime", async () => {
    await startRuntimeServices();
    expect(mocks.startBotCodeRelay).toHaveBeenCalledTimes(1);
    expect(mocks.ensureRoutineScheduler).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileOrphanedWorkingTasks).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileRoomRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.setLeaseLostListener).toHaveBeenCalledTimes(1);
    const lostLeaseListener = mocks.setLeaseLostListener.mock.calls[0]?.[0] as ((taskIds: string[]) => void) | undefined;
    lostLeaseListener?.(["task"]);
    expect(mocks.abortTaskSessionsAfterLeaseLoss).toHaveBeenCalledWith(["task"]);
  });

  it("routes restart recovery through Goal Loop control instead of a normal task prompt", async () => {
    const task = { id: "task", sessionId: "session", directory: "C:/work" };
    mocks.isGoalLoopSessionOwned.mockReturnValue(true);
    mocks.isGoalLoopRestartResumable.mockReturnValue(true);
    mocks.readGoalLoopState.mockReturnValue({ status: "running" });
    mocks.goalLoopCommand.mockResolvedValue({ status: "queued" });

    await startRuntimeServices();
    const onOrphanedTasks = mocks.setOrphanedTaskListener.mock.calls[0]?.[0] as
      ((tasks: Array<typeof task>) => void) | undefined;
    expect(onOrphanedTasks).toBeTypeOf("function");
    onOrphanedTasks?.([task]);
    const deps = mocks.handleOrphanedTasks.mock.calls[0]?.[1] as {
      resumeGoalLoop: (id: string, prompt: string) => Promise<unknown>;
    } | undefined;
    expect(deps?.resumeGoalLoop).toBeTypeOf("function");
    await deps?.resumeGoalLoop("task", "restart instruction");
    expect(mocks.goalLoopCommand).toHaveBeenCalledWith("task", {
      action: "resume",
      restartPrompt: "restart instruction",
    });
    expect(mocks.promptTask).not.toHaveBeenCalled();
  });

  it("does not start any owner-only service once the Backend owns the runtime", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    await startRuntimeServices();
    expect(mocks.startBotCodeRelay).not.toHaveBeenCalled();
    expect(mocks.ensureRoutineScheduler).not.toHaveBeenCalled();
    expect(mocks.reconcileOrphanedWorkingTasks).not.toHaveBeenCalled();
    expect(mocks.reconcileRoomRuntime).not.toHaveBeenCalled();
    expect(mocks.setLeaseLostListener).not.toHaveBeenCalled();
  });

  it("reuses one startup across calls", async () => {
    await Promise.all([startRuntimeServices(), startRuntimeServices()]);
    await startRuntimeServices();
    expect(mocks.ensureRoutineScheduler).toHaveBeenCalledTimes(1);
  });
});
