import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  goalLoopCommand: vi.fn(),
  isTaskRuntimeBusyForGoalLoopStart: vi.fn(),
  assertLocalRuntimeAllowed: vi.fn(),
}));
vi.mock("@/lib/bots", () => ({ getBot: mocks.getBot, botTaskId: (id: string) => `bot:${id}` }));
vi.mock("@/lib/pi/harness", () => ({
  goalLoopCommand: mocks.goalLoopCommand,
  isTaskRuntimeBusyForGoalLoopStart: mocks.isTaskRuntimeBusyForGoalLoopStart,
}));
vi.mock("@/lib/pi/runtime-ownership", () => ({ assertLocalRuntimeAllowed: mocks.assertLocalRuntimeAllowed }));

import { startBotGoalLoop } from "./bot-goal-loop-start";

describe("startBotGoalLoop", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getBot.mockReturnValue({ id: "bot-1" });
    mocks.isTaskRuntimeBusyForGoalLoopStart.mockReturnValue(false);
    mocks.goalLoopCommand.mockResolvedValue({ status: "queued" });
  });

  it("initializes a first Bot session through the command without requiring a task row", async () => {
    // Bot goals retain the Bot prompt size bound, not the ordinary task route's 4000-char bound.
    const goal = "x".repeat(5000);
    await expect(startBotGoalLoop("bot-1", {
      goal, acceptance: [" テスト成功 "], maxTurns: 1000, cooldownSeconds: 999999,
    })).resolves.toEqual({ loop: { status: "queued" }, agent: null });
    expect(mocks.goalLoopCommand).toHaveBeenCalledWith("bot:bot-1", {
      action: "start", goal, acceptance: ["テスト成功"], maxTurns: 100,
      cooldownSeconds: 86400, forceFullRun: false, images: undefined,
    });
  });

  it("checks ownership before touching a Bot", async () => {
    mocks.assertLocalRuntimeAllowed.mockImplementation(() => { throw new Error("not owned"); });
    await expect(startBotGoalLoop("bot-1", { goal: "直す" })).rejects.toThrow("not owned");
    expect(mocks.getBot).not.toHaveBeenCalled();
    expect(mocks.goalLoopCommand).not.toHaveBeenCalled();
  });

  it("refuses a missing Bot and a busy task", async () => {
    mocks.getBot.mockReturnValue(undefined);
    await expect(startBotGoalLoop("missing", { goal: "直す" })).rejects.toMatchObject({ status: 404 });
    mocks.getBot.mockReturnValue({ id: "bot-1" });
    mocks.isTaskRuntimeBusyForGoalLoopStart.mockReturnValue(true);
    await expect(startBotGoalLoop("bot-1", { goal: "直す" })).rejects.toMatchObject({ status: 409 });
    expect(mocks.goalLoopCommand).not.toHaveBeenCalled();
  });

  it.each([
    { goal: "" },
    { goal: "直す", acceptance: "not an array" },
    { goal: "直す", maxTurns: {} },
    { goal: "直す", forceFullRun: "yes" },
    { goal: "直す", images: "invalid" },
  ])("validates forwarded input before starting: %j", async (input) => {
    await expect(startBotGoalLoop("bot-1", input)).rejects.toMatchObject({ status: 400 });
    expect(mocks.goalLoopCommand).not.toHaveBeenCalled();
  });

  it("refuses a command result that is not live", async () => {
    mocks.goalLoopCommand.mockResolvedValue({ status: "stopped" });
    await expect(startBotGoalLoop("bot-1", { goal: "直す" })).rejects.toMatchObject({ status: 409 });
  });
});
