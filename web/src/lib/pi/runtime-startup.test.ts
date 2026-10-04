import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startBotCodeRelay: vi.fn(),
  acquireRuntimeOwner: vi.fn(() => vi.fn()),
  dataDir: vi.fn(() => "C:/leafcode-data"),
  setRuntimeOwnerUnavailable: vi.fn((unavailable: boolean) => {
    (globalThis as typeof globalThis & { __leafcodeRuntimeOwnerUnavailable?: boolean }).__leafcodeRuntimeOwnerUnavailable = unavailable;
  }),
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

vi.mock("@backend-core/app-paths.mjs", () => ({ dataDir: mocks.dataDir }));
vi.mock("@backend-core/runtime-owner-lock.mjs", () => ({ acquireRuntimeOwner: mocks.acquireRuntimeOwner }));
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
  setRuntimeOwnerUnavailable: mocks.setRuntimeOwnerUnavailable,
  assertLocalRuntimeAllowed: vi.fn(),
}));

import { startRuntimeServices } from "./runtime-startup";

const globals = globalThis as typeof globalThis & {
  __leafcodeRuntimeStartup?: unknown;
  __leafcodeRuntimeOwnerRelease?: () => void;
  __leafcodeRuntimeOwnerUnavailable?: boolean;
};

describe("startRuntimeServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireRuntimeOwner.mockReset().mockImplementation(() => vi.fn());
    mocks.dataDir.mockReset().mockReturnValue("C:/leafcode-data");
    mocks.setRuntimeOwnerUnavailable.mockReset().mockImplementation((unavailable: boolean) => {
      globals.__leafcodeRuntimeOwnerUnavailable = unavailable;
    });
    globals.__leafcodeRuntimeOwnerUnavailable = undefined;
    mocks.localRuntimeBlocked.mockReturnValue(false);
    // The singleton is cached on globalThis so Next route bundles share one startup.
    globals.__leafcodeRuntimeStartup = undefined;
  });
  afterEach(() => {
    globals.__leafcodeRuntimeStartup = undefined;
    globals.__leafcodeRuntimeOwnerRelease?.();
    globals.__leafcodeRuntimeOwnerRelease = undefined;
    globals.__leafcodeRuntimeOwnerUnavailable = undefined;
  });

  it("claims the shared owner slot before starting owner-only services", async () => {
    await startRuntimeServices();
    expect(mocks.acquireRuntimeOwner).toHaveBeenCalledOnce();
    expect(mocks.dataDir).toHaveBeenCalledOnce();
    expect(mocks.setRuntimeOwnerUnavailable).toHaveBeenCalledWith(false);
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

  it("does not claim or start owner-only services once the Backend owns the runtime", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    await startRuntimeServices();
    expect(mocks.acquireRuntimeOwner).not.toHaveBeenCalled();
    expect(mocks.startBotCodeRelay).not.toHaveBeenCalled();
    expect(mocks.ensureRoutineScheduler).not.toHaveBeenCalled();
    expect(mocks.reconcileOrphanedWorkingTasks).not.toHaveBeenCalled();
    expect(mocks.reconcileRoomRuntime).not.toHaveBeenCalled();
    expect(mocks.setLeaseLostListener).not.toHaveBeenCalled();
  });

  it("rejects startup when another process owns the shared data directory", async () => {
    mocks.acquireRuntimeOwner.mockImplementation(() => { throw new Error("runtime already owned"); });
    await expect(Promise.resolve().then(startRuntimeServices)).rejects.toThrow("runtime already owned");
    expect(mocks.setRuntimeOwnerUnavailable).toHaveBeenCalledWith(true);
    await expect(Promise.resolve().then(startRuntimeServices)).rejects.toThrow("runtime owner slot is unavailable");
    expect(mocks.acquireRuntimeOwner).toHaveBeenCalledOnce();
    expect(mocks.ensureRoutineScheduler).not.toHaveBeenCalled();
  });

  it("reuses one startup and owner claim across calls", async () => {
    await Promise.all([startRuntimeServices(), startRuntimeServices()]);
    await startRuntimeServices();
    expect(mocks.ensureRoutineScheduler).toHaveBeenCalledTimes(1);
    expect(mocks.acquireRuntimeOwner).toHaveBeenCalledOnce();
  });
});
