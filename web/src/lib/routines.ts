import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "@/lib/paths";
import { botTaskId, getBot, listBots } from "@/lib/bots";
import { getTaskDetail, promptTask } from "@/lib/pi/harness";
import type { RoutineDto } from "@/lib/types";
export const ROUTINE_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const ROUTINE_MAX_ENABLED = 10;
export const ROUTINE_MAX_FAILURES = 3;
const routineRuns = new Map<string, Promise<unknown>>();
type RoutineFile = RoutineDto;
function routineDir(botId: string): string { return join(dataDir(), "bots", botId, "routines"); }
function routinePath(botId: string, routineId: string): string { return join(routineDir(botId), `${routineId}.json`); }
function validId(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value); }
function assertRoutineId(value: string): void { if (!validId(value)) throw new Error("invalid routine id"); }
function writeRoutine(routine: RoutineFile): RoutineDto { mkdirSync(routineDir(routine.botId), { recursive: true }); writeFileSync(routinePath(routine.botId, routine.id), `${JSON.stringify(routine, null, 2)}\n`, "utf8"); return routine; }
function parseRoutine(botId: string, file: string): RoutineDto | null {
  try { const value = JSON.parse(readFileSync(join(routineDir(botId), file), "utf8")) as Partial<RoutineDto>; if (value.botId !== botId || typeof value.id !== "string" || !validId(value.id) || typeof value.name !== "string" || typeof value.prompt !== "string" || typeof value.schedule !== "string") return null; return { id: value.id, botId, name: value.name, prompt: value.prompt, schedule: value.schedule, enabled: value.enabled !== false, createdAt: String(value.createdAt), updatedAt: String(value.updatedAt), failureCount: typeof value.failureCount === "number" && Number.isInteger(value.failureCount) && value.failureCount >= 0 ? value.failureCount : 0, lastRunAt: typeof value.lastRunAt === "string" ? value.lastRunAt : null }; } catch { return null; }
}
const FIELD_LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
function fieldValues(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>(); for (const part of field.split(",")) { const token = part.trim(); if (!token) throw new Error("cron に空の項目があります"); const [base, stepText] = token.split("/"); const step = stepText === undefined ? 1 : Number(stepText); if (!Number.isInteger(step) || step < 1) throw new Error("cron の間隔が不正です"); let start = min; let end = max; if (base !== "*") { const range = base.split("-"); if (range.length > 2 || !/^\d+$/.test(range[0]) || (range[1] !== undefined && !/^\d+$/.test(range[1]))) throw new Error("cron の値が不正です"); start = Number(range[0]); end = range[1] === undefined ? start : Number(range[1]); if (start > end) throw new Error("cron の範囲が不正です"); } if (start < min || end > max) throw new Error("cron の値が範囲外です"); for (let value = start; value <= end; value += step) values.add(value); } return values;
}
export type ParsedCron = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
export function parseCron(schedule: string): ParsedCron { const fields = schedule.trim().split(/\s+/); if (fields.length !== 5) throw new Error("cron は 5 項目（分 時 日 月 曜日）で指定してください"); return fields.map((field, index) => { const limits = FIELD_LIMITS[index]; return fieldValues(field, limits[0], limits[1]); }) as ParsedCron; }
export function cronMatches(scheduleOrParsed: string | ParsedCron, date: Date): boolean { const [minutes, hours, days, months, weekdays] = typeof scheduleOrParsed === "string" ? parseCron(scheduleOrParsed) : scheduleOrParsed; return minutes.has(date.getMinutes()) && hours.has(date.getHours()) && days.has(date.getDate()) && months.has(date.getMonth() + 1) && (weekdays.has(date.getDay()) || (date.getDay() === 0 && weekdays.has(7))); }
export function validateRoutineSchedule(schedule: string): void {
  const [minutes, hours, days, months] = parseCron(schedule);
  // Without a year field, every valid month/day can fall on any weekday.
  // Use a leap year and UTC to check month lengths without local-time shifts.
  const hasDate = [...months].some((month) => {
    const lastDay = new Date(Date.UTC(2000, month, 0)).getUTCDate();
    return [...days].some((day) => day <= lastDay);
  });
  if (!hasDate) throw new Error("この cron は実行されない日時を指定しています");

  let previous: number | null = null;
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    if (!minutes.has(minute % 60) || !hours.has(Math.floor(minute / 60))) continue;
    if (previous !== null && (minute - previous) * 60_000 < ROUTINE_MIN_INTERVAL_MS) throw new Error("ルーティンの最短間隔は 5 分です");
    previous = minute;
  }
}
export function listRoutines(botId: string): RoutineDto[] { if (!getBot(botId) || !existsSync(routineDir(botId))) return []; return readdirSync(routineDir(botId)).filter((file) => file.endsWith(".json")).map((file) => parseRoutine(botId, file)).filter((item): item is RoutineDto => Boolean(item)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
export function getRoutine(botId: string, routineId: string): RoutineDto | undefined { if (!getBot(botId) || !validId(routineId)) return undefined; return parseRoutine(botId, `${routineId}.json`) ?? undefined; }
export function createRoutine(botId: string, input: { name: string; prompt: string; schedule: string; enabled?: boolean }): RoutineDto { if (!getBot(botId)) throw new Error("Bot not found"); const name = input.name.trim(); const prompt = input.prompt.trim(); const schedule = input.schedule.trim(); if (!name || !prompt) throw new Error("ルーティン名とプロンプトは必須です"); validateRoutineSchedule(schedule); const enabled = input.enabled !== false; if (enabled && listRoutines(botId).filter((item) => item.enabled).length >= ROUTINE_MAX_ENABLED) throw new Error(`有効なルーティンは最大 ${ROUTINE_MAX_ENABLED} 件です`); const now = new Date().toISOString(); return writeRoutine({ id: randomUUID(), botId, name, prompt, schedule, enabled, createdAt: now, updatedAt: now, failureCount: 0, lastRunAt: null }); }
export function patchRoutine(botId: string, routineId: string, patch: Partial<Pick<RoutineDto, "name" | "prompt" | "schedule" | "enabled">>): RoutineDto | undefined { const current = getRoutine(botId, routineId); if (!current) return undefined; const next = { ...current, ...patch, name: (patch.name ?? current.name).trim(), prompt: (patch.prompt ?? current.prompt).trim(), schedule: (patch.schedule ?? current.schedule).trim(), updatedAt: new Date().toISOString() }; if (!next.name || !next.prompt) throw new Error("ルーティン名とプロンプトは必須です"); validateRoutineSchedule(next.schedule); if (next.enabled && !current.enabled && listRoutines(botId).filter((item) => item.enabled).length >= ROUTINE_MAX_ENABLED) throw new Error(`有効なルーティンは最大 ${ROUTINE_MAX_ENABLED} 件です`); return writeRoutine(next); }
export function deleteRoutine(botId: string, routineId: string): boolean { const current = getRoutine(botId, routineId); if (!current) return false; rmSync(routinePath(botId, routineId), { force: true }); return true; }
function markRoutineStart(routine: RoutineDto): RoutineDto { return writeRoutine({ ...routine, lastRunAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); }
export async function runRoutine(botId: string, routineId: string): Promise<RoutineDto> { const key = `${botId}:${routineId}`; const running = routineRuns.get(key); if (running) { await running; const latest = getRoutine(botId, routineId); if (!latest) throw new Error("Routine not found"); return latest; } const run = (async () => { const routine = getRoutine(botId, routineId); const bot = getBot(botId); if (!routine || !bot) throw new Error("Routine not found"); if (!routine.enabled) throw new Error("ルーティンは無効です"); markRoutineStart(routine); try { await promptTask(botTaskId(botId), `[ルーティン: ${routine.name}]\n${routine.prompt}`, undefined, { waitForCompletion: true, permissionMode: bot.permissionMode ?? undefined }); const detail = await getTaskDetail(botTaskId(botId)); const latest = [...detail.messages].reverse().find((message) => message.role === "assistant"); if (detail.status === "error" || detail.error || latest?.error) throw new Error(detail.error || latest?.error || "Bot の実行に失敗しました"); const current = getRoutine(botId, routineId); if (!current) throw new Error("Routine was deleted"); return writeRoutine({ ...current, failureCount: 0, updatedAt: new Date().toISOString() }); } catch (error) { const current = getRoutine(botId, routineId); if (!current) throw error; const failureCount = current.failureCount + 1; const updated = writeRoutine({ ...current, failureCount, enabled: current.enabled && failureCount < ROUTINE_MAX_FAILURES, updatedAt: new Date().toISOString() }); const suffix = failureCount >= ROUTINE_MAX_FAILURES ? "（連続失敗のため自動的に無効化しました）" : ""; throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`); } })(); routineRuns.set(key, run); try { return await run; } finally { if (routineRuns.get(key) === run) routineRuns.delete(key); } }
export async function tickRoutines(now = new Date()): Promise<void> { const minute = new Date(now); minute.setSeconds(0, 0); for (const bot of listBots()) { for (const routine of listRoutines(bot.id)) { if (!routine.enabled || !cronMatches(routine.schedule, minute)) continue; if (routine.lastRunAt && new Date(routine.lastRunAt).getTime() >= minute.getTime()) continue; void runRoutine(bot.id, routine.id).catch(() => undefined); } } }
type SchedulerState = { interval?: ReturnType<typeof setInterval>; started?: boolean };
const schedulerState = (globalThis as typeof globalThis & { __leafcodeRoutineScheduler?: SchedulerState }).__leafcodeRoutineScheduler ??= {};
export function ensureRoutineScheduler(): void { if (schedulerState.started) return; schedulerState.started = true; schedulerState.interval = setInterval(() => { void tickRoutines(); }, 60_000); if (typeof schedulerState.interval === "object" && "unref" in schedulerState.interval) schedulerState.interval.unref(); void tickRoutines(); }