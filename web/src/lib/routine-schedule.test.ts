import { describe, expect, it } from "vitest";
import { describeRoutineSchedule, nextRoutineRunAt, routineScheduleCron, routineScheduleDraft } from "./routine-schedule";

it.each([
  ["30 8 * * *", "daily", "毎日 08:30", "30 8 * * *"],
  ["0 9 * * 1-5", "weekly", "平日（月〜金） 09:00", "0 9 * * 1,2,3,4,5"],
  ["45 18 * * 7", "weekly", "毎週 日 18:45", "45 18 * * 0"],
  ["0 0 31 * *", "monthly", "毎月 31日 00:00", "0 0 31 * *"],
  ["15 * * * *", "hourly", "毎時 15分", "15 * * * *"],
  ["*/5 * * * *", "interval", "5分ごと", "*/5 * * * *"],
])("round-trips supported schedule %s", (schedule, frequency, summary, normalized) => {
  const draft = routineScheduleDraft(schedule);
  expect(draft.frequency).toBe(frequency);
  expect(routineScheduleCron(draft)).toBe(normalized);
  expect(describeRoutineSchedule(schedule)).toBe(summary);
});

it.each(["0 9 1 * 1", "0 9 * 2 *", "0 8,17 * * *", "*/7 * * * *", "0 9 * * */2", "not cron"])("preserves unsupported cron %s", (schedule) => {
  const draft = routineScheduleDraft(schedule);
  expect(draft.frequency).toBe("custom");
  expect(routineScheduleCron(draft)).toBe(schedule);
});

it("does not generate a schedule from incomplete time or weekdays", () => {
  const daily = routineScheduleDraft("0 9 * * *");
  expect(routineScheduleCron({ ...daily, time: "" })).toBe("");
  expect(routineScheduleCron({ ...daily, time: "24:00" })).toBe("");
  expect(routineScheduleCron({ ...daily, frequency: "weekly", weekdays: [] })).toBe("");
});

describe("nextRoutineRunAt", () => {
  it("returns the next occurrence for hourly schedules", () => {
    const from = new Date(2026, 8, 12, 10, 15, 42);
    expect(nextRoutineRunAt("0 * * * *", from)).toEqual(new Date(2026, 8, 12, 11, 0));
  });

  it("supports cron steps and Sunday written as 7", () => {
    const from = new Date(2026, 8, 12, 10, 1);
    const next = nextRoutineRunAt("*/5 * * * 7", from);
    expect(next?.getDay()).toBe(0);
    expect(next?.getMinutes()).toBe(0);
  });

  it("returns null for malformed schedules", () => {
    expect(nextRoutineRunAt("not cron")).toBeNull();
  });
});
