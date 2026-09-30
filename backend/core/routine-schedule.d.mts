export type ParsedCron = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];

export function parseCronField(field: string, min: number, max: number): Set<number>;
export function parseCron(schedule: string): ParsedCron;
export function weekdayMatches(weekdays: Set<number>, weekday: number): boolean;
export function cronMatches(scheduleOrParsed: string | ParsedCron, date: Date): boolean;

export const DEFAULT_ROUTINE_SCHEDULE: string;
export const ROUTINE_WEEKDAYS: string[];
export const ROUTINE_INTERVALS: number[];

export type RoutineScheduleDraft = {
  frequency: "daily" | "weekly" | "monthly" | "hourly" | "interval" | "custom";
  time: string;
  weekdays: number[];
  day: string;
  minute: string;
  interval: string;
  cron: string;
};

export function routineScheduleDraft(schedule: string): RoutineScheduleDraft;
export function routineScheduleCron(draft: RoutineScheduleDraft): string;
export function describeRoutineSchedule(schedule: string): string;
export function nextRoutineRunAt(schedule: string, from?: Date): Date | null;
