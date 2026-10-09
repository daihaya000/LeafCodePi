import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "@/lib/paths";
import { cronMatches, parseCron, weekdayMatches } from "@/lib/routine-schedule";
import { isTransientRoutineStartError, nextRoutineFailureState, routineAutoDisabled, releaseSchedulerLock, runSchedulerTick, tryAcquireSchedulerLock } from "@backend-core/routine-scheduler.mjs";
import { newOwner as newLockOwner, ownerFile as lockOwnerFile, readOwnerSync as readLockOwnerSync, reclaimable as lockReclaimable, withDirectoryLock } from "@backend-core/directory-lock.mjs";
import { botTaskId, getBot, listBots } from "@/lib/bots";
import { getTaskDetail, promptTask } from "@/lib/pi/harness";
import type { RoutineDto, RoutineRunEventDto, UiMessage } from "@/lib/types";
export const ROUTINE_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const ROUTINE_MAX_ENABLED = 10;
export const ROUTINE_MAX_FAILURES = 3;
/** Scheduled instructions repeat without user review, so keep their context bounded. */
export const ROUTINE_MAX_PROMPT_CHARS = 8_000;
/** Embedded in the prompt every scheduled run ("[ルーティン: name]"); a short label, not a document. */
export const ROUTINE_MAX_NAME_CHARS = 100;
/** Desktop通知の本文に載せる返信プレビューの上限（コードポイント）。 */
export const ROUTINE_MAX_PREVIEW_CHARS = 120;

/**
 * 完了したルーティン実行を、BotView を開いていない画面にも届けるための in-process バス。
 * 購読側は `/api/bots/events`（SSE）で WebUI へ転送する。
 */
const ROUTINE_RUN_EVENT = "__bot_routine_run__";
function routineRunBus(): EventEmitter {
  const holder = globalThis as typeof globalThis & { __leafcodeRoutineRunBus?: EventEmitter };
  if (!holder.__leafcodeRoutineRunBus) {
    const bus = new EventEmitter();
    // 購読は接続中のタブ数だけ増える（既定の10件だと警告が出る）。
    bus.setMaxListeners(0);
    holder.__leafcodeRoutineRunBus = bus;
  }
  return holder.__leafcodeRoutineRunBus;
}
export function subscribeRoutineRuns(listener: (event: RoutineRunEventDto) => void): () => void {
  const bus = routineRunBus();
  bus.on(ROUTINE_RUN_EVENT, listener);
  return () => { bus.off(ROUTINE_RUN_EVENT, listener); };
}
function publishRoutineRun(event: RoutineRunEventDto): void {
  routineRunBus().emit(ROUTINE_RUN_EVENT, event);
}
/** 通知本文用の1行プレビュー。改行・連続空白は詰め、長文は切る。 */
function previewOf(message: UiMessage | undefined): string | null {
  const text = (message?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  const chars = Array.from(compact);
  return chars.length > ROUTINE_MAX_PREVIEW_CHARS
    ? `${chars.slice(0, ROUTINE_MAX_PREVIEW_CHARS - 1).join("")}\u2026`
    : compact;
}
const routineRuns = new Map<string, Promise<unknown>>();
const ROUTINE_LOCK_STALE_MS = 30_000;
/** Cross-worker run claim; long enough for a Bot prompt to finish. */
const ROUTINE_RUN_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const ROUTINE_RUN_LOCK_HEARTBEAT_MS = 30_000;
type RoutineFile = RoutineDto;
function routineDir(botId: string): string { return join(dataDir(), "bots", botId, "routines"); }
function routinePath(botId: string, routineId: string): string { return join(routineDir(botId), `${routineId}.json`); }
function routineLockPath(botId: string, routineId: string): string { return join(routineDir(botId), `${routineId}.lock`); }
function routineRunLockPath(botId: string, routineId: string): string { return join(routineDir(botId), `${routineId}.run.lock`); }
function withFileLock<T>(lock: string, parent: string, action: () => T): T {
  return withDirectoryLock({ lockPath: lock, parentDir: parent, staleMs: ROUTINE_LOCK_STALE_MS, busyMessage: "routine file is busy" }, action);
}
function withRoutineLock<T>(botId: string, routineId: string, action: () => T): T { return withFileLock(routineLockPath(botId, routineId), routineDir(botId), action); }
function withBotRoutineLock<T>(botId: string, action: () => T): T { const botsDir = join(dataDir(), "bots"); return withFileLock(join(botsDir, `${botId}.routines.lock`), botsDir, action); }
function validId(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value); }
function assertRoutinePromptLength(prompt: string): void {
  if (Array.from(prompt).length > ROUTINE_MAX_PROMPT_CHARS) {
    throw Object.assign(new Error(`ルーチンのプロンプトは${ROUTINE_MAX_PROMPT_CHARS}文字以内にしてください`), { status: 400 });
  }
}
function assertRoutineNameLength(name: string): void {
  if (Array.from(name).length > ROUTINE_MAX_NAME_CHARS) {
    throw Object.assign(new Error(`ルーチン名は${ROUTINE_MAX_NAME_CHARS}文字以内にしてください`), { status: 400 });
  }
}
function writeRoutine(routine: RoutineFile): RoutineDto { mkdirSync(routineDir(routine.botId), { recursive: true }); writeFileSync(routinePath(routine.botId, routine.id), `${JSON.stringify(routine, null, 2)}\n`, "utf8"); return routine; }
/** Parsed routine per file, reused while its size, mtime (ns) and inode are unchanged (the scheduler lists every Bot each minute). */
const routineParseCache = new Map<string, { stamp: string; routine: RoutineDto | null }>();
const ROUTINE_PARSE_CACHE_LIMIT = 2_000;
function parseRoutine(botId: string, file: string): RoutineDto | null {
  const full = join(routineDir(botId), file);
  let stamp: string | null = null;
  try { const stat = statSync(full, { bigint: true }); stamp = `${botId}:${stat.size}:${stat.mtimeNs}:${stat.ino}`; } catch { /* unreadable: parse reports it */ }
  const cached = stamp === null ? undefined : routineParseCache.get(full);
  if (cached && cached.stamp === stamp) return cached.routine ? { ...cached.routine } : null;
  const routine = parseRoutineFile(botId, file);
  if (stamp !== null) {
    routineParseCache.delete(full);
    routineParseCache.set(full, { stamp, routine });
    if (routineParseCache.size > ROUTINE_PARSE_CACHE_LIMIT) { const oldest = routineParseCache.keys().next().value; if (oldest !== undefined) routineParseCache.delete(oldest); }
  }
  return routine ? { ...routine } : null;
}
function parseRoutineFile(botId: string, file: string): RoutineDto | null {
  try { const value = JSON.parse(readFileSync(join(routineDir(botId), file), "utf8")) as Partial<RoutineDto>; if (value.botId !== botId || typeof value.id !== "string" || !validId(value.id) || typeof value.name !== "string" || typeof value.prompt !== "string" || typeof value.schedule !== "string") return null; return { id: value.id, botId, name: value.name, prompt: value.prompt, schedule: value.schedule, enabled: value.enabled !== false, createdAt: String(value.createdAt), updatedAt: String(value.updatedAt), failureCount: typeof value.failureCount === "number" && Number.isInteger(value.failureCount) && value.failureCount >= 0 ? value.failureCount : 0, lastRunAt: typeof value.lastRunAt === "string" ? value.lastRunAt : null }; } catch { return null; }
}
const MINUTES_PER_DAY = 24 * 60;
const DAYS_PER_GREGORIAN_CYCLE = 146_097;
const MINUTES_PER_GREGORIAN_CYCLE = DAYS_PER_GREGORIAN_CYCLE * MINUTES_PER_DAY;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
// The cron parser lives in routine-schedule.ts (client-safe) so the schedule
// picker's next-run preview and this scheduler share one implementation.
export { cronMatches, parseCron } from "@/lib/routine-schedule";
export type { ParsedCron } from "@/lib/routine-schedule";
export function validateRoutineSchedule(schedule: string): void {
  const [minutes, hours, days, months, weekdays] = parseCron(schedule);
  const scheduledMinutes = [...hours].flatMap((hour) => [...minutes].map((minute) => hour * 60 + minute)).sort((left, right) => left - right);
  for (let index = 1; index < scheduledMinutes.length; index += 1) {
    if ((scheduledMinutes[index] - scheduledMinutes[index - 1]) * MS_PER_MINUTE < ROUTINE_MIN_INTERVAL_MS) throw new Error("ルーティンの最短間隔は 5 分です");
  }

  // A cron has no year field, so a 400-year Gregorian cycle covers every calendar/weekday combination.
  // Scan dates in UTC to validate month lengths and the gap across midnight without local-time shifts.
  const start = Date.UTC(2000, 0, 1);
  const firstMinute = scheduledMinutes[0];
  const lastMinute = scheduledMinutes[scheduledMinutes.length - 1];
  let firstEvent: number | null = null;
  let lastEvent: number | null = null;
  for (let day = 0; day < DAYS_PER_GREGORIAN_CYCLE; day += 1) {
    const date = new Date(start + day * MS_PER_DAY);
    if (!days.has(date.getUTCDate()) || !months.has(date.getUTCMonth() + 1) || !weekdayMatches(weekdays, date.getUTCDay())) continue;
    const eventStart = day * MINUTES_PER_DAY + firstMinute;
    if (firstEvent === null) firstEvent = eventStart;
    if (lastEvent !== null && (eventStart - lastEvent) * MS_PER_MINUTE < ROUTINE_MIN_INTERVAL_MS) throw new Error("ルーティンの最短間隔は 5 分です");
    lastEvent = day * MINUTES_PER_DAY + lastMinute;
  }
  if (firstEvent === null || lastEvent === null) throw new Error("この cron は実行されない日時を指定しています");
  if ((MINUTES_PER_GREGORIAN_CYCLE + firstEvent - lastEvent) * MS_PER_MINUTE < ROUTINE_MIN_INTERVAL_MS) throw new Error("ルーティンの最短間隔は 5 分です");
}
function validateRoutineInputSchedule(schedule: string): void {
  try { validateRoutineSchedule(schedule); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error("Invalid schedule"), { status: 400 }); }
}
export function listRoutines(botId: string): RoutineDto[] { assertConfigurationOwner(); if (!getBot(botId) || !existsSync(routineDir(botId))) return []; return readdirSync(routineDir(botId)).filter((file) => file.endsWith(".json")).map((file) => parseRoutine(botId, file)).filter((item): item is RoutineDto => Boolean(item)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
export function getRoutine(botId: string, routineId: string): RoutineDto | undefined { assertConfigurationOwner(); if (!getBot(botId) || !validId(routineId)) return undefined; return parseRoutine(botId, `${routineId}.json`) ?? undefined; }
export function createRoutine(botId: string, input: { name: string; prompt: string; schedule: string; enabled?: boolean }): RoutineDto {
  assertConfigurationOwner();
  if (!getBot(botId)) throw Object.assign(new Error("Bot not found"), { status: 404 });
  return withBotRoutineLock(botId, () => {
    if (!getBot(botId)) throw Object.assign(new Error("Bot not found"), { status: 404 });
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    const schedule = input.schedule.trim();
    if (!name || !prompt) throw Object.assign(new Error("ルーティン名とプロンプトは必須です"), { status: 400 });
    assertRoutineNameLength(name);
    assertRoutinePromptLength(prompt);
    validateRoutineInputSchedule(schedule);
    const enabled = input.enabled !== false;
    if (enabled && listRoutines(botId).filter((item) => item.enabled).length >= ROUTINE_MAX_ENABLED) throw Object.assign(new Error(`有効なルーティンは最大 ${ROUTINE_MAX_ENABLED} 件です`), { status: 400 });
    const now = new Date().toISOString();
    return writeRoutine({ id: randomUUID(), botId, name, prompt, schedule, enabled, createdAt: now, updatedAt: now, failureCount: 0, lastRunAt: null });
  });
}
export function patchRoutine(botId: string, routineId: string, patch: Partial<Pick<RoutineDto, "name" | "prompt" | "schedule" | "enabled">>): RoutineDto | undefined {
  assertConfigurationOwner();
  if (!getRoutine(botId, routineId)) return undefined;
  return withBotRoutineLock(botId, () => withRoutineLock(botId, routineId, () => {
    const current = getRoutine(botId, routineId);
    if (!current) return undefined;
    const next = { ...current, ...patch, name: (patch.name ?? current.name).trim(), prompt: (patch.prompt ?? current.prompt).trim(), schedule: (patch.schedule ?? current.schedule).trim(), updatedAt: new Date().toISOString() };
    if (!next.name || !next.prompt) throw Object.assign(new Error("ルーティン名とプロンプトは必須です"), { status: 400 });
    assertRoutineNameLength(next.name);
    assertRoutinePromptLength(next.prompt);
    validateRoutineInputSchedule(next.schedule);
    if (next.enabled && !current.enabled && listRoutines(botId).filter((item) => item.enabled).length >= ROUTINE_MAX_ENABLED) throw Object.assign(new Error(`有効なルーティンは最大 ${ROUTINE_MAX_ENABLED} 件です`), { status: 400 });
    return writeRoutine(next);
  }));
}
export function deleteRoutine(botId: string, routineId: string): boolean {
  assertConfigurationOwner();
  if (!getRoutine(botId, routineId)) return false;
  return withBotRoutineLock(botId, () => withRoutineLock(botId, routineId, () => {
    if (!getRoutine(botId, routineId)) return false;
    rmSync(routinePath(botId, routineId), { force: true });
    return true;
  }));
}
function updateRoutine(botId: string, routineId: string, update: (routine: RoutineDto) => RoutineDto): RoutineDto | undefined {
  return withRoutineLock(botId, routineId, () => {
    const current = getRoutine(botId, routineId);
    return current ? writeRoutine(update(current)) : undefined;
  });
}

type RoutineRunClaim = { lock: string; token: string };

function tryClaimRoutineRun(botId: string, routineId: string): RoutineRunClaim | undefined {
  const lock = routineRunLockPath(botId, routineId);
  mkdirSync(routineDir(botId), { recursive: true });
  const claim = (): RoutineRunClaim => {
    mkdirSync(lock);
    const token = newLockOwner();
    try { writeFileSync(lockOwnerFile(lock), token, "utf8"); }
    catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
    return { lock, token };
  };
  try {
    return claim();
  } catch {
    try {
      // Only a stale claim whose owner process is gone is taken over; the former owner
      // then cannot delete the new claim because release checks the token.
      const seen = readLockOwnerSync(lock);
      const ownerFile = lockOwnerFile(lock);
      const agePath = existsSync(ownerFile) ? ownerFile : lock;
      if (lockReclaimable(Date.now() - statSync(agePath).mtimeMs, seen, ROUTINE_RUN_LOCK_STALE_MS) && readLockOwnerSync(lock) === seen) {
        rmSync(lock, { recursive: true, force: true });
        return claim();
      }
    } catch { /* another worker owns or replaced the lock */ }
    return undefined;
  }
}

function releaseRoutineRun(claim: RoutineRunClaim): void {
  // A claim taken over by another worker carries a different token and must stay.
  if (readLockOwnerSync(claim.lock) === claim.token) rmSync(claim.lock, { recursive: true, force: true });
}

function startRoutineRunClaimHeartbeat(claim: RoutineRunClaim): () => void {
  let warned = false;
  const timer = setInterval(() => {
    try {
      if (readLockOwnerSync(claim.lock) !== claim.token) {
        clearInterval(timer);
        return;
      }
      const now = new Date();
      utimesSync(lockOwnerFile(claim.lock), now, now);
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn("[routines] failed to refresh run claim", error);
      }
    }
  }, ROUTINE_RUN_LOCK_HEARTBEAT_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export async function runRoutine(botId: string, routineId: string): Promise<RoutineDto> {
  assertConfigurationOwner();
  const key = `${botId}:${routineId}`;
  // The run-lock path is derived from these ids; reject unknown ids before
  // claiming the lock so invalid ids cannot create directories.
  if (!getRoutine(botId, routineId)) throw new Error("Routine not found");
  const running = routineRuns.get(key);
  if (running) {
    await running;
    const latest = getRoutine(botId, routineId);
    if (!latest) throw new Error("Routine not found");
    return latest;
  }
  const run = (async () => {
    const claim = tryClaimRoutineRun(botId, routineId);
    if (!claim) {
      throw Object.assign(new Error("タスクは別のワーカーで実行中です"), { status: 409 });
    }
    const stopClaimHeartbeat = startRoutineRunClaimHeartbeat(claim);
    try {
      const routine = getRoutine(botId, routineId);
      const bot = getBot(botId);
      if (!routine || !bot) throw new Error("Routine not found");
      if (!bot.enabled) throw new Error("Botは無効です");
      if (!routine.enabled) throw new Error("ルーティンは無効です");
      try {
        assertRoutinePromptLength(routine.prompt);
        await promptTask(botTaskId(botId), `[ルーティン: ${routine.name}]\n${routine.prompt}`, undefined, {
          waitForCompletion: true,
          permissionMode: bot.permissionMode ?? undefined,
        });
        const detail = await getTaskDetail(botTaskId(botId), { offline: true });
        const latest = [...detail.messages].reverse().find((message) => message.role === "assistant");
        if (detail.status === "error" || detail.error || latest?.error) {
          throw new Error(detail.error || latest?.error || "Bot の実行に失敗しました");
        }
        const updated = updateRoutine(botId, routineId, (current) => ({
          ...current,
          lastRunAt: new Date().toISOString(),
          failureCount: 0,
          updatedAt: new Date().toISOString(),
        }));
        if (!updated) throw new Error("Routine was deleted");
        publishRoutineRun({
          botId, botName: bot.name, routineId, routineName: routine.name,
          ok: true, at: updated.lastRunAt ?? new Date().toISOString(),
          preview: previewOf(latest), error: null, failureCount: 0, autoDisabled: false,
        });
        return updated;
      } catch (error) {
        if (isTransientRoutineStartError(error)) throw error;
        const updated = updateRoutine(botId, routineId, (current) => ({
          ...current,
          // The auto-disable ladder lives in backend core.
          ...nextRoutineFailureState(current, ROUTINE_MAX_FAILURES),
          updatedAt: new Date().toISOString(),
        }));
        if (!updated) throw error;
        const message = error instanceof Error ? error.message : String(error);
        publishRoutineRun({
          botId, botName: bot.name, routineId, routineName: routine.name,
          ok: false, at: new Date().toISOString(), preview: null, error: message,
          failureCount: updated.failureCount, autoDisabled: !updated.enabled,
        });
        const suffix = routineAutoDisabled(updated.failureCount, ROUTINE_MAX_FAILURES) ? "（連続失敗のため自動的に無効化しました）" : "";
        throw new Error(`${message}${suffix}`);
      }
    } finally {
      stopClaimHeartbeat();
      releaseRoutineRun(claim);
    }
  })();
  routineRuns.set(key, run);
  try {
    return await run;
  } finally {
    if (routineRuns.get(key) === run) routineRuns.delete(key);
  }
}
function tryRoutineSchedulerLock(): string | undefined {
  return tryAcquireSchedulerLock({
    lockPath: join(dataDir(), "bots", "routines.scheduler.lock"),
    parentDir: join(dataDir(), "bots"),
    staleMs: ROUTINE_LOCK_STALE_MS,
  });
}
export async function tickRoutines(now = new Date()): Promise<void> {
  assertConfigurationOwner();
  // Lock, due decision and detached starts live in backend core; storage and
  // the run itself stay here and are resolved at call time.
  return runSchedulerTick({
    acquireLock: () => tryRoutineSchedulerLock(),
    releaseLock: (lock) => releaseSchedulerLock(lock),
    listBots: () => listBots(),
    listRoutines: (botId) => listRoutines(botId),
    cronMatches: (schedule, minute) => cronMatches(schedule, minute),
    minIntervalMs: ROUTINE_MIN_INTERVAL_MS,
    runRoutine: (botId, routineId) => runRoutine(botId, routineId),
  }, now);
}
type SchedulerState = { interval?: ReturnType<typeof setInterval>; started?: boolean };
const schedulerState = (globalThis as typeof globalThis & { __leafcodeRoutineScheduler?: SchedulerState }).__leafcodeRoutineScheduler ??= {};
export function ensureRoutineScheduler(): void { assertConfigurationOwner(); if (schedulerState.started) return; schedulerState.started = true; schedulerState.interval = setInterval(() => { void tickRoutines(); }, 60_000); if (typeof schedulerState.interval === "object" && "unref" in schedulerState.interval) schedulerState.interval.unref(); void tickRoutines(); }