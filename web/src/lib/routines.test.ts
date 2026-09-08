import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ root: "", promptTask: vi.fn(), getTaskDetail: vi.fn() }));
vi.mock("./paths", async (importOriginal) => { const actual = await importOriginal<typeof import("./paths")>(); return { ...actual, dataDir: () => state.root }; });
vi.mock("./pi/harness", () => ({ promptTask: state.promptTask, getTaskDetail: state.getTaskDetail }));
import { createBot } from "./bots";
import { createRoutine, cronMatches, getRoutine, listRoutines, parseCron, patchRoutine, runRoutine, validateRoutineSchedule } from "./routines";

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
  it.each(["0", "7", "1-7", "1,7", "1-7/2"])("matches Sunday for weekday field %s", (weekdays) => {
    const schedule = `0 9 * * ${weekdays}`;
    const sunday = new Date(2024, 0, 7, 9, 0);
    expect(cronMatches(schedule, sunday)).toBe(true);
    expect(cronMatches(parseCron(schedule), sunday)).toBe(true);
  });
  it("still applies every other cron field when Sunday is written as 7", () => {
    const schedule = "0 9 7 1 7";
    expect(cronMatches(schedule, new Date(2024, 0, 7, 9, 1))).toBe(false);
    expect(cronMatches(schedule, new Date(2024, 0, 7, 10, 0))).toBe(false);
    expect(cronMatches(schedule, new Date(2024, 0, 14, 9, 0))).toBe(false);
    expect(cronMatches(schedule, new Date(2024, 3, 7, 9, 0))).toBe(false);
    expect(cronMatches("0 9 * * 7", new Date(2024, 0, 8, 9, 0))).toBe(false);
  });
  it("includes Sunday in a saved all-week routine", () => {
    const bot = createBot({ name: "Routine bot" });
    const routine = createRoutine(bot.id, { name: "Daily", prompt: "Check status", schedule: "0 9 * * 1-7" });
    expect(cronMatches(getRoutine(bot.id, routine.id)!.schedule, new Date(2024, 0, 7, 9, 0))).toBe(true);
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
