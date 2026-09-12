import { describe, expect, it } from "vitest";
import { nextRoutineRunAt } from "./routine-schedule";

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
