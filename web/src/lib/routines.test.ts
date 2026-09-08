import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ root: "", promptTask: vi.fn(), getTaskDetail: vi.fn() }));
vi.mock("./paths", async (importOriginal) => { const actual = await importOriginal<typeof import("./paths")>(); return { ...actual, dataDir: () => state.root }; });
vi.mock("./pi/harness", () => ({ promptTask: state.promptTask, getTaskDetail: state.getTaskDetail }));
import { createBot } from "./bots";
import { createRoutine, cronMatches, getRoutine, listRoutines, patchRoutine, runRoutine, validateRoutineSchedule } from "./routines";

describe("routine cron and persistence", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-routines-")); state.root = root;
    state.promptTask.mockReset(); state.getTaskDetail.mockReset();
    state.getTaskDetail.mockResolvedValue({ status: "idle", messages: [] });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); state.root = ""; });
  it("matches cron fields and rejects intervals shorter than five minutes", () => {
    expect(cronMatches("*/5 * * * *", new Date(2024, 0, 1, 0, 10))).toBe(true);
    expect(cronMatches("*/5 * * * *", new Date(2024, 0, 1, 0, 11))).toBe(false);
    expect(() => validateRoutineSchedule("* * * * *")).toThrow();
    expect(() => validateRoutineSchedule("0 * * * *")).not.toThrow();
  });
  it("keeps a routine disabled when its in-flight run fails", async () => {
    const bot = createBot({ name: "Routine bot" });
    const routine = createRoutine(bot.id, { name: "Hourly", prompt: "Check status", schedule: "0 * * * *" });
    let rejectRun!: (error: Error) => void;
    state.promptTask.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectRun = reject; }));

    const run = runRoutine(bot.id, routine.id);
    const rejection = expect(run).rejects.toThrow("Routine failure");
    patchRoutine(bot.id, routine.id, { enabled: false });
    rejectRun(new Error("Routine failure"));
    await rejection;

    expect(getRoutine(bot.id, routine.id)).toMatchObject({ enabled: false, failureCount: 1 });
    await expect(runRoutine(bot.id, routine.id)).rejects.toThrow("ルーティンは無効です");
    expect(state.promptTask).toHaveBeenCalledTimes(1);
  });
  it("keeps an enabled routine active until three consecutive failures", async () => {
    const bot = createBot({ name: "Routine bot" });
    const routine = createRoutine(bot.id, { name: "Hourly", prompt: "Check status", schedule: "0 * * * *" });
    state.promptTask.mockRejectedValue(new Error("Routine failure"));

    for (let failureCount = 1; failureCount <= 3; failureCount += 1) {
      await expect(runRoutine(bot.id, routine.id)).rejects.toThrow("Routine failure");
      expect(getRoutine(bot.id, routine.id)).toMatchObject({ enabled: failureCount < 3, failureCount });
    }
    await expect(runRoutine(bot.id, routine.id)).rejects.toThrow("ルーティンは無効です");
    expect(state.promptTask).toHaveBeenCalledTimes(3);
  });
  it("persists routine fields under the bot home", () => {
    const bot = createBot({ name: "Routine bot" });
    const routine = createRoutine(bot.id, { name: "Hourly", prompt: "Check status", schedule: "0 * * * *" });
    expect(listRoutines(bot.id)).toMatchObject([{ id: routine.id, name: "Hourly", enabled: true, failureCount: 0, lastRunAt: null }]);
    expect(JSON.parse(readFileSync(join(root, "bots", bot.id, "routines", `${routine.id}.json`), "utf8"))).toMatchObject({ prompt: "Check status", schedule: "0 * * * *" });
  });
});
