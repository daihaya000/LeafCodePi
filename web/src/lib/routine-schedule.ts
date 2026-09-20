const FIELD_LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
const LOOKAHEAD_MINUTES = 4 * 366 * 24 * 60;

export type ParsedCron = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];

/** Parse one cron field. Shared with the scheduler (routines.ts) so the shown
 *  next-run time and the executed minute can never drift apart. */
export function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const token = part.trim();
    if (!token) throw new Error("cron に空の項目があります");
    const [base, stepText] = token.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error("cron の間隔が不正です");
    let start = min;
    let end = max;
    if (base !== "*") {
      const range = base.split("-");
      if (range.length > 2 || !/^\d+$/.test(range[0]) || (range[1] !== undefined && !/^\d+$/.test(range[1]))) throw new Error("cron の値が不正です");
      start = Number(range[0]);
      end = range[1] === undefined ? start : Number(range[1]);
      if (start > end) throw new Error("cron の範囲が不正です");
    }
    if (start < min || end > max) throw new Error("cron の値が範囲外です");
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(schedule: string): ParsedCron {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron は 5 項目（分 時 日 月 曜日）で指定してください");
  return fields.map((field, index) => {
    const limits = FIELD_LIMITS[index];
    return parseCronField(field, limits[0], limits[1]);
  }) as ParsedCron;
}

export function weekdayMatches(weekdays: Set<number>, weekday: number): boolean {
  return weekdays.has(weekday) || (weekday === 0 && weekdays.has(7));
}

export function cronMatches(scheduleOrParsed: string | ParsedCron, date: Date): boolean {
  const [minutes, hours, days, months, weekdays] = typeof scheduleOrParsed === "string" ? parseCron(scheduleOrParsed) : scheduleOrParsed;
  return minutes.has(date.getMinutes()) && hours.has(date.getHours()) && days.has(date.getDate()) && months.has(date.getMonth() + 1) && weekdayMatches(weekdays, date.getDay());
}

export const DEFAULT_ROUTINE_SCHEDULE = "0 9 * * *";
export const ROUTINE_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
export const ROUTINE_INTERVALS = [5, 10, 15, 20, 30];
export type RoutineScheduleDraft = {
  frequency: "daily" | "weekly" | "monthly" | "hourly" | "interval" | "custom";
  time: string;
  weekdays: number[];
  day: string;
  minute: string;
  interval: string;
  cron: string;
};

/** Only map schedules the picker can represent losslessly; leave everything else in cron mode. */
export function routineScheduleDraft(schedule: string): RoutineScheduleDraft {
  const draft: RoutineScheduleDraft = { frequency: "custom", time: "09:00", weekdays: [1, 2, 3, 4, 5], day: "1", minute: "0", interval: "15", cron: schedule };
  const fields = schedule.trim().split(/\s+/);
  try { parseCron(schedule); } catch { return draft; }
  const [minute, hour, day, month, weekday] = fields;
  if (month !== "*") return draft;
  if (hour === "*" && day === "*" && weekday === "*" && /^\*\/\d+$/.test(minute) && ROUTINE_INTERVALS.includes(Number(minute.slice(2)))) {
    return { ...draft, frequency: "interval", interval: String(Number(minute.slice(2))) };
  }
  if (!/^\d+$/.test(minute)) return draft;
  draft.minute = String(Number(minute));
  if (hour === "*" && day === "*" && weekday === "*") return { ...draft, frequency: "hourly" };
  if (!/^\d+$/.test(hour)) return draft;
  draft.time = `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`;
  if (day === "*" && weekday === "*") return { ...draft, frequency: "daily" };
  if (/^\d+$/.test(day) && weekday === "*") return { ...draft, frequency: "monthly", day: String(Number(day)) };
  if (day === "*" && /^[\d,-]+$/.test(weekday)) {
    const weekdays = [...new Set([...parseCronField(weekday, 0, 7)].map((value) => value % 7))].sort((a, b) => a - b);
    return { ...draft, frequency: "weekly", weekdays };
  }
  return draft;
}

export function routineScheduleCron(draft: RoutineScheduleDraft): string {
  if (draft.frequency === "custom") return draft.cron;
  if (draft.frequency === "interval") return ROUTINE_INTERVALS.includes(Number(draft.interval)) ? `*/${draft.interval} * * * *` : "";
  if (draft.frequency === "hourly") return /^\d+$/.test(draft.minute) && Number(draft.minute) < 60 ? `${Number(draft.minute)} * * * *` : "";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return "";
  const [hour, minute] = draft.time.split(":").map(Number);
  if (draft.frequency === "weekly") return draft.weekdays.length ? `${minute} ${hour} * * ${draft.weekdays.join(",")}` : "";
  if (draft.frequency === "monthly") return /^\d+$/.test(draft.day) && Number(draft.day) >= 1 && Number(draft.day) <= 31 ? `${minute} ${hour} ${Number(draft.day)} * *` : "";
  return `${minute} ${hour} * * *`;
}

export function describeRoutineSchedule(schedule: string): string {
  const draft = routineScheduleDraft(schedule);
  switch (draft.frequency) {
    case "daily": return `毎日 ${draft.time}`;
    case "weekly": return `${draft.weekdays.join(",") === "1,2,3,4,5" ? "平日（月〜金）" : `毎週 ${draft.weekdays.map((day) => ROUTINE_WEEKDAYS[day]).join("・")}`} ${draft.time}`;
    case "monthly": return `毎月 ${draft.day}日 ${draft.time}`;
    case "hourly": return `毎時 ${draft.minute}分`;
    case "interval": return `${draft.interval}分ごと`;
    case "custom": return `カスタム: ${schedule}`;
  }
}

/** Returns the next local-time occurrence after `from`, or null for an invalid/impossible schedule. */
export function nextRoutineRunAt(schedule: string, from = new Date()): Date | null {
  let parsed: ParsedCron;
  try {
    parsed = parseCron(schedule);
  } catch {
    return null;
  }
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let minute = 0; minute < LOOKAHEAD_MINUTES; minute += 1) {
    if (cronMatches(parsed, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}
