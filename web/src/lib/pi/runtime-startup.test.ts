import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startBotCodeRelay: vi.fn(),
  reconcileOrphanedWorkingTasks: vi.fn(),
  ensureRoutineScheduler: vi.fn(),
  reconcileRoomRuntime: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
}));

vi.mock("@/lib/pi/harness", () => ({
  startBotCodeRelay: mocks.startBotCodeRelay,
  promptTask: vi.fn(),
  // Left out on purpose: the optional warmups are skipped instead of importing their modules here.
  getTaskSummariesWithTodoProgress: undefined,
  listModelsForAccounts: undefined,
}));
vi.mock("@/lib/routines", () => ({ ensureRoutineScheduler: mocks.ensureRoutineScheduler }));
vi.mock("@/lib/task-runtime-lease", () => ({
  reconcileOrphanedWorkingTasks: mocks.reconcileOrphanedWorkingTasks,
  // No listener, so the resume wiring is skipped instead of importing the store here.
  setOrphanedTaskListener: undefined,
}));
vi.mock("@/lib/room-runtime", () => ({ reconcileRoomRuntime: mocks.reconcileRoomRuntime }));
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

  it("starts the owner-only services while this process owns the runtime", async () => {
    await startRuntimeServices();
    expect(mocks.startBotCodeRelay).toHaveBeenCalledTimes(1);
    expect(mocks.ensureRoutineScheduler).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileOrphanedWorkingTasks).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileRoomRuntime).toHaveBeenCalledTimes(1);
  });

  it("does not start the owner-only services once the Backend owns the runtime", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    await startRuntimeServices();
    expect(mocks.startBotCodeRelay).not.toHaveBeenCalled();
    expect(mocks.ensureRoutineScheduler).not.toHaveBeenCalled();
    // The remaining startup steps still run: only the owner's services are skipped here.
    expect(mocks.reconcileOrphanedWorkingTasks).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileRoomRuntime).toHaveBeenCalledTimes(1);
  });

  it("reuses one startup across calls", async () => {
    await Promise.all([startRuntimeServices(), startRuntimeServices()]);
    await startRuntimeServices();
    expect(mocks.ensureRoutineScheduler).toHaveBeenCalledTimes(1);
  });
});
