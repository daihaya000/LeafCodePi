const FIELD_LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
const LOOKAHEAD_MINUTES = 4 * 366 * 24 * 60;

type ParsedSchedule = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [base, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!base || !Number.isInteger(step) || step < 1) throw new Error("invalid cron");
    let start = min;
    let end = max;
    if (base !== "*") {
      const range = base.split("-");
      if (range.length > 2 || !/^\d+$/.test(range[0]) || (range[1] !== undefined && !/^\d+$/.test(range[1]))) throw new Error("invalid cron");
      start = Number(range[0]);
      end = range[1] === undefined ? start : Number(range[1]);
    }
    if (start < min || end > max || start > end) throw new Error("invalid cron");
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function parseSchedule(schedule: string): ParsedSchedule {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("invalid cron");
  return fields.map((field, index) => {
    const limits = FIELD_LIMITS[index];
    return parseField(field, limits[0], limits[1]);
  }) as ParsedSchedule;
}

function matches(schedule: ParsedSchedule, date: Date): boolean {
  const [minutes, hours, days, months, weekdays] = schedule;
  const weekday = date.getDay();
  return minutes.has(date.getMinutes()) && hours.has(date.getHours()) && days.has(date.getDate()) && months.has(date.getMonth() + 1) && (weekdays.has(weekday) || (weekday === 0 && weekdays.has(7)));
}

/** Returns the next local-time occurrence after `from`, or null for an invalid/impossible schedule. */
export function nextRoutineRunAt(schedule: string, from = new Date()): Date | null {
  let parsed: ParsedSchedule;
  try {
    parsed = parseSchedule(schedule);
  } catch {
    return null;
  }
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let minute = 0; minute < LOOKAHEAD_MINUTES; minute += 1) {
    if (matches(parsed, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}
