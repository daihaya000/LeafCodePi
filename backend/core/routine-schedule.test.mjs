import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  cronMatches, DEFAULT_ROUTINE_SCHEDULE, describeRoutineSchedule, nextRoutineRunAt, parseCron, parseCronField,
  ROUTINE_INTERVALS, ROUTINE_WEEKDAYS, routineScheduleCron, routineScheduleDraft, weekdayMatches,
} from "./routine-schedule.mjs";

test("a field accepts wildcards, steps, ranges and lists", () => {
  assert.deepEqual([...parseCronField("*", 0, 5)], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCronField("*/15", 0, 59)], [0, 15, 30, 45]);
  assert.deepEqual([...parseCronField("5-7", 0, 59)], [5, 6, 7]);
  assert.deepEqual([...parseCronField("1,3,5", 0, 7)], [1, 3, 5]);
  assert.deepEqual([...parseCronField("2-6/2", 0, 7)], [2, 4, 6]);
  assert.deepEqual([...parseCronField("0", 0, 59)], [0]);
});

test("a malformed field is refused instead of widened", () => {
  for (const field of ["", " ", "1-", "a", "1/0", "1/x", "5-3", "0-60", "60", "1,,2"]) {
    assert.throws(() => parseCronField(field, 0, 59), /cron/, JSON.stringify(field));
  }
});

test("a schedule needs exactly five fields within their limits", () => {
  assert.equal(parseCron("0 9 * * *").length, 5);
  assert.deepEqual([...parseCron("0 9 * * *")[0]], [0]);
  for (const schedule of ["", "* * * *", "* * * * * *", "0 24 * * *", "0 9 0 * *", "0 9 * 13 *"]) {
    assert.throws(() => parseCron(schedule), /cron/, schedule);
  }
  // Sunday is both 0 and 7.
  assert.equal(weekdayMatches(parseCron("0 0 * * 0")[4], 0), true);
  assert.equal(weekdayMatches(parseCron("0 0 * * 7")[4], 0), true);
  assert.equal(weekdayMatches(parseCron("0 0 * * 1")[4], 1), true);
  assert.equal(weekdayMatches(parseCron("0 0 * * 1")[4], 3), false);
});

test("matching reads local time components", () => {
  assert.equal(cronMatches("* * * * *", new Date(2026, 0, 5, 3, 7)), true);
  assert.equal(cronMatches(DEFAULT_ROUTINE_SCHEDULE, new Date(2026, 0, 5, 9, 0)), true);
  assert.equal(cronMatches(DEFAULT_ROUTINE_SCHEDULE, new Date(2026, 0, 5, 9, 1)), false);
  assert.equal(cronMatches("0 9 5 1 *", new Date(2026, 0, 5, 9, 0)), true);
  assert.equal(cronMatches("0 9 6 1 *", new Date(2026, 0, 5, 9, 0)), false);
});

test("the next run is the next minute that matches, and null when nothing can", () => {
  assert.deepEqual(nextRoutineRunAt("0 9 * * *", new Date(2026, 0, 5, 8, 59)), new Date(2026, 0, 5, 9, 0));
  assert.deepEqual(nextRoutineRunAt("*/15 * * * *", new Date(2026, 0, 5, 9, 1)), new Date(2026, 0, 5, 9, 15));
  // The candidate minute itself is excluded (strictly after `from`).
  assert.deepEqual(nextRoutineRunAt("0 9 * * *", new Date(2026, 0, 5, 9, 0)), new Date(2026, 0, 6, 9, 0));
  assert.equal(nextRoutineRunAt("0 9 31 2 *", new Date(2026, 0, 5, 9, 0)), null);
  assert.equal(nextRoutineRunAt("nonsense", new Date(2026, 0, 5, 9, 0)), null);
});

test("the picker draft maps only the schedules it can represent losslessly", () => {
  assert.deepEqual(routineScheduleDraft("*/15 * * * *"), { frequency: "interval", time: "09:00", weekdays: [1, 2, 3, 4, 5], day: "1", minute: "0", interval: "15", cron: "*/15 * * * *" });
  assert.equal(routineScheduleDraft("7 * * * *").frequency, "hourly");
  assert.equal(routineScheduleDraft("0 9 * * *").frequency, "daily");
  assert.equal(routineScheduleDraft("30 18 * * *").time, "18:30");
  assert.deepEqual(routineScheduleDraft("0 9 3 * *").day, "3");
  assert.equal(routineScheduleDraft("0 9 3 * *").frequency, "monthly");
  assert.deepEqual(routineScheduleDraft("0 9 * * 1,3").weekdays, [1, 3]);
  assert.equal(routineScheduleDraft("0 9 * * 0,7").frequency, "weekly");
  assert.deepEqual(routineScheduleDraft("0 9 * * 0,7").weekdays, [0]);
  // Cron modes the picker cannot express stay custom, with the original schedule kept.
  for (const schedule of ["0 9 1 2 *", "*/7 * * * *", "0 9 * * 1-5/2", "bad"]) {
    assert.equal(routineScheduleDraft(schedule).frequency, "custom", schedule);
    assert.equal(routineScheduleDraft(schedule).cron, schedule);
  }
});

test("the draft round-trips back into the same schedule where the picker allows it", () => {
  for (const schedule of ["*/15 * * * *", "7 * * * *", "0 9 * * *", "0 9 3 * *", "0 9 * * 1,3"]) {
    assert.equal(routineScheduleCron(routineScheduleDraft(schedule)), schedule, schedule);
  }
  // A custom draft is returned verbatim.
  assert.equal(routineScheduleCron({ frequency: "custom", cron: "1 2 3 4 5", time: "", weekdays: [], day: "", minute: "", interval: "" }), "1 2 3 4 5");
  // Invalid drafts produce an empty schedule rather than a guess.
  const base = { time: "09:00", weekdays: [1], day: "1", minute: "0", interval: "15", cron: "" };
  assert.equal(routineScheduleCron({ ...base, frequency: "interval", interval: "7" }), "");
  assert.equal(routineScheduleCron({ ...base, frequency: "hourly", minute: "60" }), "");
  assert.equal(routineScheduleCron({ ...base, frequency: "daily", time: "24:00" }), "");
  assert.equal(routineScheduleCron({ ...base, frequency: "weekly", weekdays: [] }), "");
  assert.equal(routineScheduleCron({ ...base, frequency: "monthly", day: "32" }), "");
});

test("the description names the mode the picker recognised", () => {
  assert.equal(describeRoutineSchedule("0 9 * * *"), "毎日 09:00");
  assert.equal(describeRoutineSchedule("0 9 * * 1,2,3,4,5"), "平日（月〜金） 09:00");
  assert.equal(describeRoutineSchedule("0 9 * * 1,3"), "毎週 月・水 09:00");
  assert.equal(describeRoutineSchedule("0 9 3 * *"), "毎月 3日 09:00");
  assert.equal(describeRoutineSchedule("7 * * * *"), "毎時 7分");
  assert.equal(describeRoutineSchedule("*/15 * * * *"), "15分ごと");
  assert.equal(describeRoutineSchedule("1 2 3 4 5"), "カスタム: 1 2 3 4 5");
});

test("the exported vocabulary is the picker's", () => {
  assert.equal(DEFAULT_ROUTINE_SCHEDULE, "0 9 * * *");
  assert.deepEqual(ROUTINE_WEEKDAYS, ["日", "月", "火", "水", "木", "金", "土"]);
  assert.deepEqual(ROUTINE_INTERVALS, [5, 10, 15, 20, 30]);
});

test("plain Node parses schedules without the Web app", () => {
  const moduleUrl = new URL("./routine-schedule.mjs", import.meta.url).href;
  const code = `
    import { cronMatches, nextRoutineRunAt } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify({
      matches: cronMatches("0 9 * * *", new Date(2026, 0, 5, 9, 0)),
      next: nextRoutineRunAt("0 9 * * *", new Date(2026, 0, 5, 8, 0)).toISOString(),
    }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5_000 });
  const result = JSON.parse(output);
  assert.equal(result.matches, true);
  assert.deepEqual(new Date(result.next), new Date(2026, 0, 5, 9, 0));
});
