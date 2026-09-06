import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ root: "" }));
vi.mock("./paths", async (importOriginal) => { const actual = await importOriginal<typeof import("./paths")>(); return { ...actual, dataDir: () => state.root }; });
import { createBot } from "./bots";
import { createRoutine, cronMatches, listRoutines, validateRoutineSchedule } from "./routines";

describe("routine cron and persistence", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-routines-")); state.root = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); state.root = ""; });
  it("matches cron fields and rejects intervals shorter than five minutes", () => {
    expect(cronMatches("*/5 * * * *", new Date(2024, 0, 1, 0, 10))).toBe(true);
    expect(cronMatches("*/5 * * * *", new Date(2024, 0, 1, 0, 11))).toBe(false);
    expect(() => validateRoutineSchedule("* * * * *")).toThrow();
    expect(() => validateRoutineSchedule("0 * * * *")).not.toThrow();
  });
  it("persists routine fields under the bot home", () => {
    const bot = createBot({ name: "Routine bot" });
    const routine = createRoutine(bot.id, { name: "Hourly", prompt: "Check status", schedule: "0 * * * *" });
    expect(listRoutines(bot.id)).toMatchObject([{ id: routine.id, name: "Hourly", enabled: true, failureCount: 0, lastRunAt: null }]);
    expect(JSON.parse(readFileSync(join(root, "bots", bot.id, "routines", `${routine.id}.json`), "utf8"))).toMatchObject({ prompt: "Check status", schedule: "0 * * * *" });
  });
});
