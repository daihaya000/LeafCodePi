/**
 * LeafCode Goal Loop for Pi
 *
 * LeafCode の Goal Loop を Pi 拡張として実装したもの。
 * - 完走モード: 完了宣言を無視し、maxTurns まで必ず実行
 * - 通常モード: completed -> 検証ターン -> completed
 * - Pi native の agent_settled + sendMessage(followUp) で自動継続
 * - 状態は %APPDATA%\leafcode-pi\goals-loop/<sessionId>.json（プロジェクト内には置かない）に保存
 * - `/goal-compose` は Goal / acceptance / maxTurns / 完走モードを設定する Composer
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type GoalLoopStatus =
  | "queued"
  | "running"
  | "paused"
  | "verifying_completed"
  | "completed"
  | "blocked"
  | "stopped";

export type GoalLoopTurnKind = "goal" | "verification";
export type GoalLoopPauseReason =
  | ""
  | "user"
  | "manual_send"
  | "turn_limit"
  | "unreadable_result"
  | "turn_timeout"
  | "unknown_delivery"
  | "transcript_unreadable"
  | "boundary_lost"
  | "verification_rejected"
  | "scheduler_error";

export type GoalLoopInitialImage = {
  type: "image";
  mimeType: string;
  data: string;
};

export type GoalLoopProgress = {
  time: string;
  status: "progress" | "completed" | "verified_completed" | "blocked";
  summary: string;
  next?: string;
  evidence?: string;
};

export type GoalLoop = {
  id: string;
  sessionId: string;
  cwd: string;
  status: GoalLoopStatus;
  goal: string;
  acceptance: string[];
  maxTurns: number;
  cooldownSeconds: number;
  nextTurnAt: string | null;
  forceFullRun: boolean;
  /** Re-select the main persona before every Goal Loop turn. */
  autoAgent?: boolean;
  /** Images are included in the first Goal turn only. */
  initialImages?: GoalLoopInitialImage[];
  turnCount: number;
  turnKind: GoalLoopTurnKind;
  pauseReason: GoalLoopPauseReason;
  error: string;
  progress: GoalLoopProgress[];
  summary: string;
  evidence: string;
  blockedReason: string;
  rejectedClaims: number;
  /** 連続して結果JSONを読めなかったターン数。正常な結果で0に戻る。 */
  unreadableStreak: number;
  /** Durable: mid-turn was interrupted by session lifecycle and needs transcript recovery. */
  pendingTurnRecovery: boolean;
  /** The loop-end notice was queued for the next user prompt (sent at most once per run). */
  endNoticeSent?: boolean;
  /**
   * Operator instructions sent while this run was live. They are replayed in
   * every later turn prompt, so a long loop keeps them even after the transcript
   * they arrived in is compacted.
   */
  notes?: string[];
  createdAt: string;
  updatedAt: string;
};

const PROMPT_MARKER = "<!-- webui-goal-loop-prompt -->";
const WIDGET_KEY = "leafcode-goal-loop";
const ENTRY_TYPE = "leafcode-goal-loop";
const DEFAULT_MAX_TURNS = 10;
const MAX_TURNS = 100;
const DEFAULT_COOLDOWN_SECONDS = 0;
const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;
const MAX_GOAL_CHARS = 4_000;
const MAX_ACCEPTANCE_ITEMS = 10;
const MAX_ACCEPTANCE_CHARS = 2_000;
const MAX_PROGRESS = 50;
const INITIAL_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_INITIAL_IMAGES = 8;
const MAX_INITIAL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INITIAL_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_REJECTED_CLAIMS = 2;
const MAX_UNREADABLE_STREAK = 2;
/** Keep the replay prompt bounded; older notes fall off first. */
const MAX_NOTES = 10;
const MAX_NOTE_CHARS = 500;
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
/** Node clamps longer delays to 1ms, which would spin on a corrupt far-future timestamp. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
/**
 * A live loop must always have an armed timer. Settle/replace races could drop
 * it (the successor runtime already ran session_start), so a slow watchdog
 * re-arms one and the completion-verification turn still runs.
 */
const SCHEDULE_WATCHDOG_MS = 5_000;
const TERMINAL = new Set<GoalLoopStatus>(["completed", "stopped"]);
const UNSCHEDULABLE = new Set<GoalLoopStatus>(["paused", "blocked"]);
const ABORTED_TURN_PAUSE_ERROR = "実行が中断されたため一時停止しました。";

const runtimes = new Map<string, Runtime>();
/** Test-only override for the in-flight turn watchdog. */
let turnTimeoutMsForTests: number | undefined;
/** Test-only override for the lost-timer watchdog interval. */
let scheduleWatchdogMsForTests: number | undefined;
/** Test-only override for atomic state rename. */
let renameSyncForTests: ((temp: string, file: string) => void) | undefined;
/** Test-only: force writeLoop to fail without touching disk. */
let writeLoopFailForTests = false;
/** Test-only: allow N successful writeLoop calls, then fail. */
let writeLoopAllowCountForTests: number | undefined;

function isActiveRuntime(runtime: Runtime): boolean {
  return !runtime.disposed && runtimes.get(runtime.key) === runtime;
}

function turnTimeoutMs(): number {
  return turnTimeoutMsForTests ?? TURN_TIMEOUT_MS;
}

function scheduleWatchdogMs(): number {
  return scheduleWatchdogMsForTests ?? SCHEDULE_WATCHDOG_MS;
}

function renameGoalState(temp: string, file: string): void {
  (renameSyncForTests ?? fs.renameSync)(temp, file);
}

type GoalLoopTurnRoutingContext = ExtensionContext & {
  /** Returns false when routing replaced this session, or retry when not attached yet. */
  prepareGoalLoopTurn?: (prompt: string) => Promise<boolean | "retry">;
  /** Checks whether a provider-limit turn can be retried on a fallback route. */
  canRetryGoalLoopProviderLimit?: () => Promise<boolean>;
};

type Runtime = {
  key: string;
  cwd: string;
  sessionId: string;
  ctx: GoalLoopTurnRoutingContext;
  sessionManager: ExtensionContext["sessionManager"];
  pi: ExtensionAPI;
  awaitingTurn: boolean;
  /** Invalidates an in-flight async turn when a new loop replaces it. */
  turnGeneration: number;
  pausedTurnPending: boolean;
  pendingAgentMessages?: unknown[];
  pendingAgentAborted: boolean;
  /**
   * After abort/stop of an in-flight agent run, trailing agent_end/settled may
   * arrive after a replacement turn already set awaitingTurn. Drop that many
   * settlement waves so they cannot poison the new turn.
   */
  discardAgentSettlements: number;
  /** True while sendTurn is awaiting prepare/routing or about to send. */
  sendTurnInFlight: boolean;
  awaitingTurnIndex?: number;
  pausedTurnIndex?: number;
  timer?: ReturnType<typeof setTimeout>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** Re-arms a live loop whose scheduler timer was lost to a settle/replace race. */
  watchdogTimer?: ReturnType<typeof setInterval>;
  /** An abort-paused turn may be re-armed when it was caused by manual compaction. */
  abortedTurnPausePending: boolean;
  /** Prevent duplicate hidden end notices if persisting their flag fails. */
  endNoticeQueued: boolean;
  disposed: boolean;
};

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function runtimeKey(cwd: string, id: string): string {
  return `${cwd}\0${id}`;
}

function matchesRuntimeContext(runtime: Runtime, ctx: ExtensionContext): boolean {
  // Pi creates a new context per dispatch. The manager identifies the session
  // instance, even when a replacement reopens the same persisted session ID.
  return runtime.sessionManager === ctx.sessionManager &&
    runtime.key === runtimeKey(ctx.cwd, sessionId(ctx));
}

function legacySafeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "session";
}

export function safeIdPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized === value && sanitized.length <= 120) return sanitized || "session";
  // Replacing path separators used to make distinct legacy session IDs share a
  // state file (for example, "a/b" and "a?b"). Keep a readable prefix while
  // adding a stable digest so every raw ID has an isolated state file.
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${sanitized.slice(0, 100) || "session"}-${digest}`;
}

/**
 * 状態はプロジェクト配下に置かない（LeafCodePiはプロジェクト内 .pi を許可しない）。
 * WebUI側 dataDir()（web/src/lib/paths.ts）と同じ基底に置き、LEAFCODE_PI_DATA_DIR
 * で両側を一括上書きする。sessionIdはUUIDで一意なためファイルキーはsessionIdのみ。
 */
function goalsDir(): string {
  const override = process.env.LEAFCODE_PI_DATA_DIR?.trim();
  if (override) return path.join(override, "goals-loop");
  if (process.platform === "win32" && process.env.APPDATA?.trim()) {
    return path.join(process.env.APPDATA, "leafcode-pi", "goals-loop");
  }
  return path.join(os.homedir(), ".leafcode-pi", "goals-loop");
}

/** cwd引数は呼び出し元互換のため残す。状態配置はグローバルでcwd非依存。 */
export function goalStateFile(cwd: string, id: string): string {
  void cwd;
  return path.join(goalsDir(), `${safeIdPart(id)}.json`);
}

function legacyGoalStateFile(cwd: string, id: string): string {
  void cwd;
  return path.join(goalsDir(), `${legacySafeIdPart(id)}.json`);
}

function isoNow(): string {
  return new Date().toISOString();
}

export function clampMaxTurns(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(MAX_TURNS, Math.max(0, Math.trunc(number)))
    : DEFAULT_MAX_TURNS;
}

export function clampCooldownSeconds(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(MAX_COOLDOWN_SECONDS, Math.max(DEFAULT_COOLDOWN_SECONDS, Math.trunc(number)))
    : DEFAULT_COOLDOWN_SECONDS;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

export function parseCooldownSeconds(value: unknown): number {
  if (typeof value === "number") return clampCooldownSeconds(value);
  if (typeof value !== "string") return DEFAULT_COOLDOWN_SECONDS;
  const text = value.trim();
  if (!text) return DEFAULT_COOLDOWN_SECONDS;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return clampCooldownSeconds(Number(text));
  const token = /(\d+(?:\.\d+)?)\s*([smhd])/gi;
  let cursor = 0;
  let total = 0;
  let matched = false;
  let current: RegExpExecArray | null;
  while ((current = token.exec(text))) {
    if (text.slice(cursor, current.index).trim()) return DEFAULT_COOLDOWN_SECONDS;
    const amount = Number(current[1]);
    const multiplier = current[2].toLowerCase() === "d"
      ? 24 * 60 * 60
      : current[2].toLowerCase() === "h"
        ? 60 * 60
        : current[2].toLowerCase() === "m"
          ? 60
          : 1;
    total += amount * multiplier;
    cursor = token.lastIndex;
    matched = true;
  }
  return matched && !text.slice(cursor).trim()
    ? clampCooldownSeconds(total)
    : DEFAULT_COOLDOWN_SECONDS;
}

export function normalizeAcceptance(value: unknown): string[] | null {
  if (value === undefined || value === null || value === "") return [];
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split("\n")
      : null;
  if (!items || items.length > MAX_ACCEPTANCE_ITEMS) return null;

  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") return null;
    const text = item.trim();
    if (!text) continue;
    if (text.length > MAX_ACCEPTANCE_CHARS) return null;
    result.push(text);
  }
  return result;
}

function normalizeStatus(value: unknown): GoalLoopStatus {
  return value === "queued" ||
    value === "running" ||
    value === "paused" ||
    value === "verifying_completed" ||
    value === "completed" ||
    value === "blocked" ||
    value === "stopped"
    ? value
    : "paused";
}

function normalizeTurnKind(value: unknown): GoalLoopTurnKind {
  return value === "verification" ? "verification" : "goal";
}

function normalizePauseReason(value: unknown): GoalLoopPauseReason {
  return value === "user" ||
    value === "manual_send" ||
    value === "turn_limit" ||
    value === "unreadable_result" ||
    value === "turn_timeout" ||
    value === "unknown_delivery" ||
    value === "transcript_unreadable" ||
    value === "boundary_lost" ||
    value === "verification_rejected" ||
    value === "scheduler_error"
    ? value
    : "";
}

function normalizeProgress(value: unknown): GoalLoopProgress[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is RecordLike => {
      const record = asRecord(item);
      return Boolean(record && typeof record.summary === "string");
    })
    .slice(-MAX_PROGRESS)
    .map((item) => ({
      time: typeof item.time === "string" ? item.time : isoNow(),
      status:
        item.status === "completed" || item.status === "verified_completed" || item.status === "blocked"
          ? item.status
          : "progress",
      summary: String(item.summary).slice(0, 4_000),
      ...(typeof item.next === "string" && item.next.trim()
        ? { next: item.next.trim().slice(0, 2_000) }
        : {}),
      ...(typeof item.evidence === "string" && item.evidence.trim()
        ? { evidence: item.evidence.trim().slice(0, 4_000) }
        : {}),
    }));
}

function normalizeInitialImages(value: unknown): GoalLoopInitialImage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images: GoalLoopInitialImage[] = [];
  let totalBytes = 0;
  for (const image of value) {
    if (images.length >= MAX_INITIAL_IMAGES) break;
    const item = asRecord(image);
    if (
      !item ||
      (item.type !== undefined && item.type !== "image") ||
      typeof item.mimeType !== "string" ||
      typeof item.data !== "string" ||
      item.data.length === 0
    ) continue;
    const mimeType = item.mimeType.toLowerCase();
    const data = item.data.trim();
    if (!INITIAL_IMAGE_MIME_TYPES.has(mimeType) || !data) continue;
    // Reject oversized base64 before Buffer allocates a potentially unbounded
    // decoded payload from a restored or direct browser request.
    const remainingBytes = Math.min(MAX_INITIAL_IMAGE_BYTES, MAX_INITIAL_IMAGE_TOTAL_BYTES - totalBytes);
    const maxEncodedLength = Math.ceil(remainingBytes / 3) * 4;
    if (data.length > maxEncodedLength) continue;
    const decoded = Buffer.from(data, "base64");
    if (
      decoded.length === 0 ||
      decoded.length > MAX_INITIAL_IMAGE_BYTES ||
      totalBytes + decoded.length > MAX_INITIAL_IMAGE_TOTAL_BYTES ||
      decoded.toString("base64") !== data
    ) continue;
    totalBytes += decoded.length;
    images.push({ type: "image", mimeType, data });
  }
  return images.length ? images : undefined;
}

export function normalizeNotes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const notes: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const note = item.trim().slice(0, MAX_NOTE_CHARS);
    if (!note || notes.at(-1) === note) continue;
    notes.push(note);
  }
  return notes.length ? notes.slice(-MAX_NOTES) : undefined;
}

function normalizeNextTurnAt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? text : null;
}

function hydrateLoop(value: unknown, cwd: string, id: string): GoalLoop | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.goal !== "string") return null;
  const goal = raw.goal.trim().slice(0, MAX_GOAL_CHARS);
  if (!goal) return null;
  const acceptance = normalizeAcceptance(raw.acceptance);
  if (!acceptance) return null;
  const progress = normalizeProgress(raw.progress);
  const maxTurns = clampMaxTurns(raw.maxTurns);
  const turnCount = nonNegativeInteger(raw.turnCount);
  const forceFullRun = raw.forceFullRun === true;
  const storedStatus = normalizeStatus(raw.status);
  // A full-run loop from an older build may retain an early completed result.
  // Resume it while budget remains; an explicit completion at the limit stays terminal.
  const resumeFullRun =
    forceFullRun &&
    storedStatus === "completed" &&
    (maxTurns === 0 || turnCount < maxTurns);
  const now = isoNow();
  return {
    id,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : id,
    cwd,
    status: resumeFullRun ? "queued" : storedStatus,
    goal,
    acceptance,
    maxTurns,
    cooldownSeconds: clampCooldownSeconds(raw.cooldownSeconds),
    nextTurnAt: normalizeNextTurnAt(raw.nextTurnAt),
    forceFullRun,
    autoAgent: raw.autoAgent === true,
    initialImages: normalizeInitialImages(raw.initialImages),
    turnCount,
    turnKind: normalizeTurnKind(raw.turnKind),
    pauseReason: normalizePauseReason(raw.pauseReason),
    error: typeof raw.error === "string" ? raw.error.slice(0, 4_000) : "",
    progress,
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 4_000) : progress.at(-1)?.summary ?? "",
    evidence: typeof raw.evidence === "string" ? raw.evidence.slice(0, 4_000) : progress.at(-1)?.evidence ?? "",
    blockedReason: typeof raw.blockedReason === "string" ? raw.blockedReason.slice(0, 4_000) : "",
    rejectedClaims: nonNegativeInteger(raw.rejectedClaims),
    unreadableStreak: nonNegativeInteger(raw.unreadableStreak),
    pendingTurnRecovery: raw.pendingTurnRecovery === true,
    endNoticeSent: !resumeFullRun && raw.endNoticeSent === true,
    notes: normalizeNotes(raw.notes),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

function recoverLoopFromTemp(
  file: string,
  cwd: string,
  id: string,
  newerThan = Number.NEGATIVE_INFINITY,
  requireSessionIdMatch = false,
): GoalLoop | null {
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const temps = fs.readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".tmp"))
      .map((name) => {
        const full = path.join(dir, name);
        try {
          return { full, mtime: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { full: string; mtime: number } => entry !== null)
      .sort((a, b) => b.mtime - a.mtime);
    for (const temp of temps) {
      if (temp.mtime <= newerThan) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(temp.full, "utf8"));
        const record = asRecord(raw);
        if (requireSessionIdMatch && typeof record?.sessionId === "string" && record.sessionId !== id) continue;
        const loop = hydrateLoop(raw, cwd, id);
        if (!loop) continue;
        // Promote the newest valid temp so later reads stay consistent after a
        // crash between temp write and rename, or a torn non-atomic overwrite.
        try {
          renameGoalState(temp.full, file);
        } catch {
          fs.writeFileSync(file, JSON.stringify(loop, null, 2), "utf8");
          fs.rmSync(temp.full, { force: true });
        }
        return loop;
      } catch {
        // Try an older temp snapshot.
      }
    }
  } catch {
    // No recoverable temp snapshots.
  }
  return null;
}

function readLoop(cwd: string, id: string): GoalLoop | null {
  const file = goalStateFile(cwd, id);
  try {
    const loop = hydrateLoop(JSON.parse(fs.readFileSync(file, "utf8")), cwd, id);
    if (loop) {
      // A crash after writing the temp but before rename leaves a valid, older
      // main file. Promote only a newer temp so stale leftovers cannot regress
      // an already committed state.
      const mainMtime = fs.statSync(file).mtimeMs;
      return recoverLoopFromTemp(file, cwd, id, mainMtime) ?? loop;
    }
  } catch {
    // Missing/torn main file — fall through to temp recovery.
  }
  const recovered = recoverLoopFromTemp(file, cwd, id);
  if (recovered) return recovered;

  // Keep sessions created before collision-resistant filenames readable. Their
  // next successful state write migrates them to the new isolated filename.
  const legacyFile = legacyGoalStateFile(cwd, id);
  if (legacyFile === file) return null;
  try {
    const legacyRaw = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    const legacyRecord = asRecord(legacyRaw);
    // A collided legacy filename must not resurrect another session's state.
    // Pre-sessionId snapshots remain readable because their ownership is unknown.
    if (!(typeof legacyRecord?.sessionId === "string" && legacyRecord.sessionId !== id)) {
      const legacy = hydrateLoop(legacyRaw, cwd, id);
      if (legacy) return legacy;
    }
  } catch {
    // Missing/torn legacy state may still have a recoverable temp snapshot.
  }
  return recoverLoopFromTemp(legacyFile, cwd, id, Number.NEGATIVE_INFINITY, true);
}

function cleanupOrphanGoalTemps(file: string): void {
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${base}.`) || !name.endsWith(".tmp")) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // Best-effort; a locked temp can be swept on a later successful write.
      }
    }
  } catch {
    // Directory may be gone; leftovers remain recoverable until the next success.
  }
}

function writeLoop(loop: GoalLoop): boolean {
  if (writeLoopFailForTests) return false;
  if (writeLoopAllowCountForTests !== undefined) {
    if (writeLoopAllowCountForTests <= 0) return false;
    writeLoopAllowCountForTests -= 1;
  }
  try {
    loop.updatedAt = isoNow();
    const file = goalStateFile(loop.cwd, loop.id);
    // Initial images are needed only for the first prompt. Once its turn index
    // is durable, retaining base64 payloads can bloat every later snapshot if
    // the best-effort post-send cleanup write fails.
    const { initialImages: _initialImages, ...withoutInitialImages } = loop;
    const content = JSON.stringify(
      loop.turnCount > 0 ? withoutInitialImages : loop,
      null,
      2,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, content, "utf8");
    // WindowsではWebUIの状態読取やOneDrive同期が対象を掴むとrenameSyncが
    // EPERM/EACCES/EBUSYで即失敗する。スケジューラやsettleAwaitingTurn内のthrowは
    // 未処理reject（プロセス落下）や「queuedのままタイマー無し」を招くため、短い
    // リトライで吸収し、それでも競合する場合は非原子的だが確実な上書きで落とす。
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameGoalState(temp, file);
        // Main now has the latest snapshot; drop older crash temps so a later
        // torn main cannot revive a stale pre-success state.
        cleanupOrphanGoalTemps(file);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (attempt >= 4 || !transient) {
          // Keep the temp until the overwrite succeeds so a torn write can still
          // be recovered on the next readLoop.
          try {
            fs.writeFileSync(file, content, "utf8");
            fs.rmSync(temp, { force: true });
            cleanupOrphanGoalTemps(file);
            return true;
          } catch (fallbackError) {
            console.error("[goal-loop] writeLoop fallback failed:", fallbackError);
            return false;
          }
        }
        // 25+50+75+100ms = 250ms total before the overwrite fallback.
        const until = Date.now() + 25 * (attempt + 1);
        while (Date.now() < until) {
          // writeLoopは同期API。イベントループを長く塞がないよう最大250msまで。
        }
      }
    }
  } catch (error) {
    console.error("[goal-loop] writeLoop failed:", error);
    return false;
  }
}

function appendSnapshot(runtime: Runtime, loop: GoalLoop): void {
  try {
    const { initialImages: _initialImages, ...snapshot } = loop;
    runtime.pi.appendEntry(ENTRY_TYPE, { snapshot, at: Date.now() });
  } catch {
    // State file remains authoritative.
  }
}

function currentLoop(runtime: Runtime): GoalLoop | null {
  return readLoop(runtime.cwd, runtime.sessionId);
}

function clearTimer(runtime: Runtime): void {
  if (runtime.timer) clearTimeout(runtime.timer);
  if (runtime.timeoutTimer) clearTimeout(runtime.timeoutTimer);
  runtime.timer = undefined;
  runtime.timeoutTimer = undefined;
}

function short(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function statusLabel(status: GoalLoopStatus): string {
  return {
    queued: "送信待ち",
    running: "実行中",
    paused: "一時停止",
    verifying_completed: "完了検証中",
    completed: "完了",
    blocked: "要対応",
    stopped: "停止",
  }[status];
}

function updateUI(runtime: Runtime, loop: GoalLoop | null): void {
  try {
    if (!loop) {
      runtime.ctx.ui.setStatus(WIDGET_KEY, undefined);
      runtime.ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const turn = loop.status === "queued" ? loop.turnCount + 1 : loop.turnCount;
    const max = loop.maxTurns === 0 ? "∞" : String(loop.maxTurns);
    const shownTurn = loop.maxTurns === 0 ? turn : Math.min(turn, loop.maxTurns);
    const badge = `${statusLabel(loop.status)} ${shownTurn}/${max}`;
    const mode = loop.forceFullRun ? " · 完走" : "";
    runtime.ctx.ui.setStatus(WIDGET_KEY, `Goal ${badge}${mode}`);
    if (runtime.ctx.mode === "tui") {
      const lines = [
        `Goal Loop · ${badge}${mode}`,
        short(loop.goal, 100),
      ];
      if (loop.pauseReason && loop.error) lines.push(short(loop.error, 100));
      if (loop.progress.at(-1)) lines.push(`最新: ${short(loop.progress.at(-1)!.summary, 90)}`);
      runtime.ctx.ui.setWidget(WIDGET_KEY, lines);
    }
  } catch {
    // UI is optional in SDK/headless mode.
  }
}

function assistantText(message: unknown): string {
  const record = asRecord(message);
  if (!record || record.role !== "assistant") return "";
  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is RecordLike => Boolean(asRecord(part)))
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
  }
  const parts = record.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((part): part is RecordLike => Boolean(asRecord(part)))
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
  }
  return "";
}

function isAbortedAssistant(message: unknown): boolean {
  const record = asRecord(message);
  return record?.role === "assistant" && record.stopReason === "aborted";
}

/**
 * Recover a result that arrived after pause/abort but before the state update.
 * Pi keeps the extension custom message and the assistant reply in the session
 * branch, so this is the direct equivalent of LeafCode's transcript recovery.
 */
function lateTurnResult(runtime: Runtime, loop: GoalLoop): GoalLoopProgress | null {
  // pausedTurnPending is in-memory; pendingTurnRecovery survives session reload.
  if (!runtime.pausedTurnPending && !loop.pendingTurnRecovery) return null;
  let promptIndex = -1;
  let entries: unknown[];
  try {
    entries = runtime.ctx.sessionManager.getBranch();
  } catch {
    return null;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(entries[index]);
    const details = asRecord(entry?.details);
    // Require the interrupted turn's own prompt. A sendMessage() sync failure can
    // pause as unknown_delivery after turnCount increments but before the custom
    // message is enqueued; matching an older prompt would falsely "recover" and
    // bypass the no-resend contract.
    if (
      entry?.type === "custom_message" &&
      (entry.customType === "leafcode-goal-turn" || entry.customType === "leafcode-goal-verification") &&
      details?.goalId === loop.id &&
      details.kind === loop.turnKind &&
      Number(details.turn) === loop.turnCount
    ) {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0) return null;
  // The final assistant result wins, as in extractGoalResultFromMessages.
  let latest: GoalLoopProgress | null = null;
  for (let index = promptIndex + 1; index < entries.length; index += 1) {
    const entry = asRecord(entries[index]);
    if (entry?.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role === "user") break;
    if (message?.role === "assistant") {
      latest = extractGoalResult(assistantText(message)) ?? latest;
    }
  }
  return latest;
}

/** Top-level JSON objects, ignoring braces inside JSON strings. */
export function jsonObjectCandidates(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        result.push(text.slice(start, index + 1));
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  return result;
}

export function normalizeStructured(value: unknown): GoalLoopProgress | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const status = raw.status;
  if (status !== "progress" && status !== "completed" && status !== "blocked" && status !== "verified_completed") {
    return null;
  }
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) return null;
  const blockedReason = typeof raw.blockedReason === "string" ? raw.blockedReason.trim() : "";
  const evidence = typeof raw.evidence === "string" ? raw.evidence.trim() : "";
  const next = typeof raw.next === "string" ? raw.next.trim() : "";
  return {
    time: isoNow(),
    status,
    summary: summary.slice(0, 4_000),
    ...(next ? { next: next.slice(0, 2_000) } : {}),
    ...(evidence || blockedReason ? { evidence: (evidence || blockedReason).slice(0, 4_000) } : {}),
  };
}

export function extractGoalResult(text: string): GoalLoopProgress | null {
  // Parse fenced blocks independently: an unmatched brace in preceding prose
  // must not hide the required final JSON result.
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let index = fenced.length - 1; index >= 0; index -= 1) {
    const candidates = jsonObjectCandidates(fenced[index][1]);
    for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      try {
        const result = normalizeStructured(JSON.parse(candidates[candidateIndex]));
        if (result) return result;
      } catch {
        // Try the previous candidate in this fenced block.
      }
    }
  }
  const candidates = jsonObjectCandidates(text);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const result = normalizeStructured(JSON.parse(candidates[index]));
      if (result) return result;
    } catch {
      // Try the previous candidate.
    }
  }
  return null;
}

/**
 * A Pi agent run can contain several assistant turns when tools are used.
 * Only the last valid result in the complete run is authoritative.
 */
export function extractGoalResultFromMessages(messages: unknown[]): GoalLoopProgress | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const result = extractGoalResult(assistantText(messages[index]));
    if (result) return result;
  }
  return null;
}

function acceptanceText(loop: GoalLoop, heading = "Acceptance criteria"): string {
  return loop.acceptance.length
    ? `\n\n${heading}:\n${loop.acceptance.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
    : "";
}

function recentProgress(loop: GoalLoop, count: number): string {
  return loop.progress.length
    ? `\n\nRecent progress:\n${loop.progress
        .slice(-count)
        .map((item) => `- ${item.time}: ${item.summary}${item.next ? ` / next: ${item.next}` : ""}${item.evidence ? ` / evidence: ${item.evidence}` : ""}`)
        .join("\n")}`
    : "";
}

/**
 * Operator instructions sent while the loop was live. They ride along with every
 * later turn prompt, so compacting the transcript does not lose them.
 */
function operatorNotes(loop: GoalLoop): string {
  const notes = loop.notes?.filter((note) => note.trim()) ?? [];
  return notes.length
    ? `\n\nOperator notes added while this loop was running (they stay in force and they do not replace the acceptance criteria; the host keeps scheduling turns, so keep ending every turn with the JSON result block):\n${notes.map((note) => `- ${note}`).join("\n")}`
    : "";
}

function jsonInstructions(statuses: string): string {
  return `\n\nThe very last thing you output this turn must be a single fenced JSON block:\n\n\`\`\`json\n{"status":"progress","summary":"what changed this turn","next":"the next step","evidence":"commands run, files touched, results"}\n\`\`\`\n\n- status must be exactly one of: ${statuses}.\n- summary is required. Put a blocked reason in blockedReason when status is blocked.\n- Write nothing after the closing fence.`;
}

export function buildGoalPrompt(loop: GoalLoop, turn: number): string {
  const max = loop.maxTurns;
  const turnBudget = max === 0
    ? `This is loop turn ${turn}. There is no automatic turn limit.`
    : `This is turn ${turn} of ${loop.forceFullRun ? "exactly" : "at most"} ${max}. ${turn - 1} loop turn(s) completed before this one.`;
  const common = `${PROMPT_MARKER}\n\n${turnBudget} The next prompt is sent automatically after this turn ends.\n\nRules:\n- One turn = one iteration. Do the smallest useful increment, then end this turn. Do not simulate future work.\n- Report only work actually performed in this turn.\n- Keep changes incremental and reviewable.\n- Do not ask questions unless truly blocked.\n\nGoal:\n${loop.goal}${acceptanceText(loop)}${recentProgress(loop, 5)}${operatorNotes(loop)}`;
  if (loop.forceFullRun) {
    return `${common}\n\nYou are running in LeafCode full-run mode. Never declare the goal complete. The host will ${max === 0 ? "continue until you pause or stop it" : `run exactly ${max} goal turns`}. A completion claim is treated as progress.${jsonInstructions("progress, blocked")}`;
  }
  return `${common}\n\nNormal mode: the turn budget is a ceiling, not a target. Once the goal and all acceptance criteria are satisfied, stop immediately; do not add cleanup, refactoring, polish, or speculative work. Report completed only with concrete evidence; the host independently verifies it.${jsonInstructions("progress, completed, blocked")}`;
}

export function buildGoalContinuationPrompt(loop: GoalLoop, turn: number): string {
  const turnBudget = loop.maxTurns === 0
    ? `This is loop turn ${turn}. There is no automatic turn limit.`
    : `This is turn ${turn} of ${loop.forceFullRun ? "exactly" : "at most"} ${loop.maxTurns}.`;
  const missingResultReminder = loop.unreadableStreak > 0
    ? "\n\nYour previous reply did not include the required JSON result block, so the loop could not read a result. This turn MUST end with the fenced JSON block described below, and nothing may come after it."
    : "";
  const common = `${PROMPT_MARKER}\n\nContinue the persistent goal loop. Work on exactly one smallest useful step, then end this turn. ${turnBudget}${missingResultReminder}\n\nGoal:\n${loop.goal}${acceptanceText(loop)}${recentProgress(loop, 2)}${operatorNotes(loop)}`;
  if (loop.forceFullRun) {
    return `${common}\n\nFull-run mode: never declare completion. The loop will ${loop.maxTurns === 0 ? "continue until you pause or stop it" : "run until the turn limit"}. Do not simulate future work.${jsonInstructions("progress, blocked")}`;
  }
  return `${common}\n\nNormal mode: the turn budget is a ceiling, not a target. If the goal and all acceptance criteria are satisfied, stop now and report completed; do not add cleanup, refactoring, polish, or speculative work. Do not claim completion without concrete evidence.${jsonInstructions("progress, completed, blocked")}`;
}

export function buildVerificationPrompt(loop: GoalLoop): string {
  const claim = [...loop.progress].reverse().find((item) => item.status === "completed") ?? loop.progress.at(-1);
  return `${PROMPT_MARKER}\n\nThe previous turn claimed the goal was completed. Independently verify that claim. Inspect the repository and run appropriate checks; do not trust the claim's narration. Do not make unrelated cleanup, refactoring, polish, or speculative changes.\n\nGoal:\n${loop.goal}${acceptanceText(loop, "Acceptance criteria to verify")}\n\nClaimed completion:\n${claim ? `summary: ${claim.summary}\nevidence: ${claim.evidence ?? "(none)"}` : "(none)"}\n\nReturn verified_completed only when every criterion is backed by observable evidence. Return progress when more work is required, or blocked when verification cannot proceed.${jsonInstructions("verified_completed, progress, blocked")}`;
}

export function applyResult(loop: GoalLoop, result: GoalLoopProgress | null): boolean {
  if (!result) {
    // Keep the same free-retry / streak semantics as a missing assistant body.
    return applyMissingResult(loop, "");
  }
  loop.unreadableStreak = 0;

  // Full-run never performs completion verification. A stale verifying_* state or
  // a model returning verified_completed must not end the loop early.
  const verification = !loop.forceFullRun && loop.status === "running" && loop.turnKind === "verification";
  const effective = loop.forceFullRun && (result.status === "completed" || result.status === "verified_completed")
    ? { ...result, status: "progress" as const }
    : result;
  loop.progress = [...loop.progress, effective].slice(-MAX_PROGRESS);
  loop.summary = effective.summary;
  loop.evidence = effective.evidence ?? "";
  loop.blockedReason = effective.status === "blocked" ? effective.evidence ?? effective.summary : "";

  if (verification) {
    if (effective.status === "verified_completed") {
      loop.status = "completed";
      loop.rejectedClaims = 0;
    } else if (effective.status === "blocked") {
      loop.status = "blocked";
    } else {
      loop.rejectedClaims += 1;
      if (loop.rejectedClaims >= MAX_REJECTED_CLAIMS) {
        loop.status = "paused";
        loop.pauseReason = "verification_rejected";
        loop.error = "完了宣言が検証で複数回拒否されたため一時停止しました。";
      } else {
        loop.status = "queued";
      }
    }
  } else if (effective.status === "completed") {
    loop.status = "verifying_completed";
  } else if (effective.status === "blocked") {
    loop.status = "blocked";
  } else {
    loop.status = "queued";
  }

  if (
    loop.status === "queued" &&
    loop.maxTurns > 0 &&
    loop.turnCount >= loop.maxTurns
  ) {
    loop.status = "paused";
    loop.pauseReason = "turn_limit";
    loop.error = "最大ターン数に到達したため一時停止しました。";
  } else if (loop.status !== "paused") {
    loop.pauseReason = "";
    loop.error = "";
  }
  loop.nextTurnAt =
    (loop.status === "queued" || loop.status === "verifying_completed") && loop.cooldownSeconds > 0
      ? new Date(Date.now() + loop.cooldownSeconds * 1000).toISOString()
      : null;
  loop.turnKind =
    verification && loop.status === "blocked"
      ? "verification"
      : loop.status === "verifying_completed"
        ? "verification"
        : "goal";
  return writeLoop(loop);
}

/**
 * The model finished a run without the required JSON result block (e.g. it only
 * updated todos). Pause only after repeated misses: keep the loop alive once by
 * recording the assistant text as a plain progress entry and demanding the JSON
 * block in the next prompt.
 */
export function applyMissingResult(loop: GoalLoop, assistantText: string): boolean {
  const verification = loop.status === "running" && loop.turnKind === "verification";
  const summary = short(assistantText, 500) || "(結果JSONなし)";
  loop.progress = [...loop.progress, { time: isoNow(), status: "progress" as const, summary }].slice(-MAX_PROGRESS);
  loop.summary = summary;
  loop.evidence = "";
  loop.blockedReason = "";
  loop.unreadableStreak = Math.max(0, Math.trunc(Number(loop.unreadableStreak) || 0)) + 1;
  loop.turnKind = verification ? "verification" : "goal";
  if (loop.unreadableStreak >= MAX_UNREADABLE_STREAK) {
    loop.status = "paused";
    loop.pauseReason = "unreadable_result";
    loop.error = `${MAX_UNREADABLE_STREAK}回連続で結果JSONを読めなかったため一時停止しました。`;
    loop.nextTurnAt = null;
  } else {
    loop.status = "queued";
    if (verification) loop.status = "verifying_completed";
    loop.pauseReason = "";
    loop.error = "";
    loop.nextTurnAt = loop.cooldownSeconds > 0
      ? new Date(Date.now() + loop.cooldownSeconds * 1000).toISOString()
      : null;
  }
  return writeLoop(loop);
}

function clearPendingAgentRun(runtime: Runtime): void {
  runtime.pendingAgentMessages = undefined;
  runtime.pendingAgentAborted = false;
}

function isAbortPausedLoop(loop: GoalLoop | null): loop is GoalLoop {
  return Boolean(
    loop &&
    loop.status === "paused" &&
    loop.pauseReason === "user" &&
    loop.error === ABORTED_TURN_PAUSE_ERROR
  );
}

/**
 * Apply a result that arrived after the loop was paused mid-turn.
 * user/manual_send keep progress but stay paused; turn_timeout/unknown_delivery continue.
 */
function applyLatePausedResult(runtime: Runtime, result: GoalLoopProgress): boolean {
  const loop = currentLoop(runtime);
  if (
    !loop ||
    loop.status !== "paused" ||
    !(runtime.pausedTurnPending || loop.pendingTurnRecovery)
  ) {
    return false;
  }
  if (
    loop.pauseReason !== "user" &&
    loop.pauseReason !== "manual_send" &&
    loop.pauseReason !== "unknown_delivery" &&
    loop.pauseReason !== "turn_timeout"
  ) {
    return false;
  }
  const pauseReason = loop.pauseReason;
  const pauseError = loop.error;
  runtime.pausedTurnPending = false;
  runtime.pausedTurnIndex = undefined;
  loop.pendingTurnRecovery = false;
  loop.status = "running";
  if (!applyResult(loop, result)) {
    // Failed persist leaves disk paused+pendingTurnRecovery. Keep runtime armed so
    // a later settle/resume can retry without double-applying from a partial memory apply.
    runtime.pausedTurnPending = true;
    return false;
  }
  const updated = currentLoop(runtime);
  if (!updated) return false;
  updateUI(runtime, updated);
  appendSnapshot(runtime, updated);
  if (
    (pauseReason === "user" || pauseReason === "manual_send") &&
    !TERMINAL.has(updated.status) &&
    !UNSCHEDULABLE.has(updated.status)
  ) {
    // Re-pause through pauseLoop so write failure does not leave UI paused while
    // disk stays queued (and later session_start would auto-continue).
    pauseLoop(runtime, pauseReason, pauseError);
    const after = currentLoop(runtime);
    if (!after || after.status !== "paused") {
      runtime.ctx.ui.notify("進捗は保存しましたが一時停止状態の保存に失敗しました。", "error");
      return false;
    }
    return true;
  }
  if (updated.status === "queued" || updated.status === "verifying_completed") {
    schedule(runtime);
  } else {
    notifyLoopEnded(runtime);
  }
  return true;
}

function assistantErrorMessage(message: unknown): string | null {
  const record = asRecord(message);
  if (!record || record.role !== "assistant" || record.stopReason !== "error") return null;
  const detail = typeof record.errorMessage === "string" ? record.errorMessage.trim() : "";
  return detail || "生成が失敗しました。";
}

function errorFromAgentMessages(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const error = assistantErrorMessage(messages[index]);
    if (error) return error;
  }
  return null;
}

async function settleAwaitingTurn(runtime: Runtime): Promise<void> {
  if (!runtime.awaitingTurn) {
    clearPendingAgentRun(runtime);
    return;
  }
  const loop = currentLoop(runtime);
  if (!loop || loop.status !== "running") {
    // A state replacement can make the durable loop non-running before this
    // delayed settlement arrives. Do not leave the runtime awaiting forever:
    // /goal-resume and the watchdog must be able to arm the next turn.
    runtime.awaitingTurn = false;
    runtime.awaitingTurnIndex = undefined;
    runtime.pausedTurnIndex = undefined;
    if (runtime.timeoutTimer) clearTimeout(runtime.timeoutTimer);
    runtime.timeoutTimer = undefined;
    clearPendingAgentRun(runtime);
    return;
  }

  const messages = runtime.pendingAgentMessages ?? [];
  const aborted = runtime.pendingAgentAborted;
  const error = errorFromAgentMessages(messages);
  const result = extractGoalResultFromMessages(messages);
  if (aborted) {
    // Keep any JSON that landed before abort (same contract as manual_send):
    // progress is preserved, but the loop stays paused for the operator.
    const paused = pauseLoop(runtime, "user", ABORTED_TURN_PAUSE_ERROR);
    if (paused) runtime.abortedTurnPausePending = true;
    if (result) applyLatePausedResult(runtime, result);
    clearPendingAgentRun(runtime);
    return;
  }
  if (error) {
    const turnGeneration = runtime.turnGeneration;
    let canRetry = false;
    try {
      canRetry = await runtime.ctx.canRetryGoalLoopProviderLimit?.() ?? false;
    } catch {
      canRetry = false;
    }
    // startLoop/session replacement may land while canRetry awaits. A stale
    // retry must not rewind the replacement's turnCount or pause it.
    if (!isActiveRuntime(runtime) || runtime.turnGeneration !== turnGeneration) {
      // A mid-await pauseLoop may have preserved pendingAgentMessages for late
      // recovery; do not wipe that evidence just because canRetry went stale.
      if (!runtime.pausedTurnPending) clearPendingAgentRun(runtime);
      return;
    }
    if (canRetry) {
      // await中にpauseLoop/session置換で状態が変わる可能性があるため、
      // await前のスナップショットではなく現在の状態に対して書き戻す。
      const fresh = currentLoop(runtime);
      if (!fresh || fresh.status !== "running") {
        if (!runtime.pausedTurnPending) clearPendingAgentRun(runtime);
        return;
      }
      if (fresh.turnKind === "goal") {
        // sendTurn leaves turnCount unchanged while unreadableStreak === 1
        // (non-consuming JSON retry). Rewinding here would steal a budgeted turn
        // and let the loop exceed maxTurns after a provider-limit fallback.
        if (fresh.unreadableStreak !== 1) {
          fresh.turnCount = Math.max(0, fresh.turnCount - 1);
        }
      }
      fresh.status = fresh.turnKind === "verification" ? "verifying_completed" : "queued";
      fresh.pauseReason = "";
      fresh.error = "";
      fresh.nextTurnAt = null;
      // Persist before clearing awaitingTurn so a failed write cannot leave
      // disk=running with runtime no longer awaiting settlement.
      if (!writeLoop(fresh)) return;
      clearTimer(runtime);
      runtime.awaitingTurn = false;
      runtime.awaitingTurnIndex = undefined;
      runtime.pausedTurnIndex = undefined;
      clearPendingAgentRun(runtime);
      updateUI(runtime, fresh);
      appendSnapshot(runtime, fresh);
      schedule(runtime);
      return;
    }
    pauseLoop(runtime, "scheduler_error", error);
    clearPendingAgentRun(runtime);
    return;
  }

  // Persist first while awaitingTurn remains true. Clearing flags before a
  // failed writeLoop left disk=running with no settlement owner.
  const persisted = result
    ? applyResult(loop, result)
    : applyMissingResult(
      loop,
      [...messages]
        .reverse()
        .map((message) => assistantText(message))
        .find((value) => value.trim()) ?? "",
    );
  if (!persisted) {
    // writeLoop failed; keep awaitingTurn/pending so timeout or resume can recover.
    return;
  }
  const updated = currentLoop(runtime);
  if (!updated || updated.status === "running") {
    // Belt-and-suspenders if disk/runtime diverged despite a true return.
    return;
  }
  runtime.awaitingTurn = false;
  runtime.awaitingTurnIndex = undefined;
  runtime.pausedTurnIndex = undefined;
  if (runtime.timeoutTimer) clearTimeout(runtime.timeoutTimer);
  runtime.timeoutTimer = undefined;
  clearPendingAgentRun(runtime);
  updateUI(runtime, updated);
  appendSnapshot(runtime, updated);
  // Keep queued work armed even when agent_settled is emitted after this handler.
  if (updated.status === "queued" || updated.status === "verifying_completed") schedule(runtime);
  else notifyLoopEnded(runtime);
}

/**
 * Queue a hidden notice for the next user prompt once the loop has stopped.
 * The loop-turn prompts stay in the conversation history after the loop ends,
 * so without this notice the model can keep imitating the "end the turn with a
 * JSON result block" contract during later normal turns. Idempotent per run;
 * resuming the loop re-arms it.
 */
function notifyLoopEnded(runtime: Runtime): void {
  const loop = currentLoop(runtime);
  if (!loop || loop.endNoticeSent || runtime.endNoticeQueued) return;
  if (!TERMINAL.has(loop.status) && loop.status !== "blocked" && loop.status !== "paused") return;
  try {
    runtime.pi.sendMessage(
      {
        customType: "leafcode-goal-loop-ended",
        content: buildLoopEndedNotice(loop.status),
        display: false,
      },
      // Never start a turn from settlement; the notice must ride along with the
      // next real user prompt, exactly like the ToDo gate reminder.
      { triggerTurn: false, deliverAs: "followUp" },
    );
  } catch (error) {
    // A failed notice must never break settlement; loop state is unaffected.
    console.error("Failed to queue the goal-loop end notice:", error);
    return;
  }
  loop.endNoticeSent = true;
  runtime.endNoticeQueued = true;
  writeLoop(loop);
}

export function buildLoopEndedNotice(status: GoalLoopStatus): string {
  return [
    `The persistent goal loop is no longer running (${status}).`,
    "The earlier goal-loop instructions ended with that loop: do NOT append the goal-loop JSON result block to later replies unless a new goal loop starts.",
    "Answer the user's next message as a normal conversation.",
  ].join("\n");
}

/**
 * Keep an operator instruction in the loop state. The message itself still goes
 * into the running turn (steer/followUp); this record is replayed in every later
 * turn prompt so a long loop keeps the instruction after compaction. A failed
 * write must not block the send, so it is best-effort and reverts the in-memory
 * copy to keep memory aligned with disk.
 */
function recordOperatorNote(runtime: Runtime, loop: GoalLoop, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  // 切り詰めは見える形で残す（全文は会話履歴にある）。
  const note = trimmed.length > MAX_NOTE_CHARS
    ? `${trimmed.slice(0, MAX_NOTE_CHARS)}…`
    : trimmed;
  const previous = loop.notes;
  if (previous?.at(-1) === note) return;
  loop.notes = [...(previous ?? []), note].slice(-MAX_NOTES);
  if (writeLoop(loop)) {
    updateUI(runtime, loop);
    return;
  }
  if (previous === undefined) delete loop.notes;
  else loop.notes = previous;
}

function pauseLoop(runtime: Runtime, reason: GoalLoopPauseReason = "user", error = "ユーザーが一時停止しました。"): boolean {
  const loop = currentLoop(runtime);
  if (!loop || TERMINAL.has(loop.status) || loop.status === "blocked") return false;
  const pending = runtime.awaitingTurn;
  const pendingIndex = runtime.awaitingTurnIndex;
  // Survive process restart: in-memory pausedTurnPending alone is not enough.
  if (pending) loop.pendingTurnRecovery = true;
  loop.status = "paused";
  loop.pauseReason = reason;
  loop.error = error;
  loop.nextTurnAt = null;
  // Persist before dropping awaitingTurn. A failed write must not strand disk as
  // running while runtime thinks the turn is already paused/settled.
  if (!writeLoop(loop)) return false;
  runtime.pausedTurnPending = pending;
  runtime.pausedTurnIndex = pendingIndex;
  // Keep agent_end evidence when pausing mid-turn so agent_settled can still
  // recover JSON after abort. Clearing here caused manual_send races to drop results.
  if (!pending) clearPendingAgentRun(runtime);
  clearTimer(runtime);
  runtime.awaitingTurn = false;
  runtime.awaitingTurnIndex = undefined;
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  notifyLoopEnded(runtime);
  return true;
}

function requeueAfterManualCompaction(runtime: Runtime): void {
  if (!runtime.abortedTurnPausePending) return;
  runtime.abortedTurnPausePending = false;
  const loop = currentLoop(runtime);
  if (!isAbortPausedLoop(loop)) {
    return;
  }

  const resumed: GoalLoop = {
    ...loop,
    status: loop.turnKind === "verification" ? "verifying_completed" : "queued",
    pauseReason: "" as const,
    error: "",
    pendingTurnRecovery: false,
    endNoticeSent: false,
    nextTurnAt: null,
  };
  if (!writeLoop(resumed)) {
    runtime.ctx.ui.notify("圧縮後のGoal loop再開状態を保存できませんでした。/goal-resume で再開してください。", "error");
    return;
  }
  runtime.awaitingTurn = false;
  runtime.pausedTurnPending = false;
  runtime.endNoticeQueued = false;
  runtime.awaitingTurnIndex = undefined;
  runtime.pausedTurnIndex = undefined;
  clearPendingAgentRun(runtime);
  clearTimer(runtime);
  updateUI(runtime, resumed);
  appendSnapshot(runtime, resumed);
  schedule(runtime, 0);
}

function stopLoop(runtime: Runtime): boolean {
  const loop = currentLoop(runtime);
  if (!loop || TERMINAL.has(loop.status)) return false;
  // Capture before clearing. Only arm discard when a trailing agent_settled is
  // actually expected — awaitingTurn while already idle should not stick the
  // counter forever and block later turns.
  const expectTrailingSettlement =
    runtime.pausedTurnPending || !runtime.ctx.isIdle();
  loop.status = "stopped";
  loop.pauseReason = "";
  loop.error = "";
  loop.blockedReason = "";
  loop.pendingTurnRecovery = false;
  loop.nextTurnAt = null;
  if (!writeLoop(loop)) return false;
  clearTimer(runtime);
  runtime.awaitingTurn = false;
  runtime.pausedTurnPending = false;
  runtime.abortedTurnPausePending = false;
  runtime.endNoticeQueued = false;
  runtime.awaitingTurnIndex = undefined;
  runtime.pausedTurnIndex = undefined;
  clearPendingAgentRun(runtime);
  try {
    if (!runtime.ctx.isIdle()) runtime.ctx.abort();
  } catch {
    // The engine may already be settled.
  }
  if (expectTrailingSettlement) {
    // One trailing wave max; += allowed duplicates to block the next real turn.
    runtime.discardAgentSettlements = 1;
  }
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  notifyLoopEnded(runtime);
  return true;
}

function completeLoop(runtime: Runtime): boolean {
  const loop = currentLoop(runtime);
  if (!loop) return false;
  const turnLimitReached =
    loop.status === "paused" &&
    loop.pauseReason === "turn_limit" &&
    loop.maxTurns > 0 &&
    loop.turnCount >= loop.maxTurns;
  // A blocked loop can be explicitly closed; verify turn-limit pauses against the budget.
  if (loop.status !== "blocked" && !turnLimitReached) return false;
  loop.status = "completed";
  loop.pauseReason = "";
  loop.error = "";
  loop.blockedReason = "";
  loop.pendingTurnRecovery = false;
  loop.nextTurnAt = null;
  if (!writeLoop(loop)) return false;
  clearTimer(runtime);
  runtime.awaitingTurn = false;
  runtime.pausedTurnPending = false;
  runtime.awaitingTurnIndex = undefined;
  runtime.pausedTurnIndex = undefined;
  clearPendingAgentRun(runtime);
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  notifyLoopEnded(runtime);
  return true;
}

function schedule(runtime: Runtime, delay = 250): void {
  if (!isActiveRuntime(runtime) || runtime.timer) return;
  runtime.timer = setTimeout(() => {
    runtime.timer = undefined;
    // Piのdispose()はsession_shutdownを発火しないため、セッション置換後の旧
    // ランタイムはdisposedにならない。新ランタイムが同じキーで上書き登録済み
    // なら自分は現行ではないので、同一状態ファイルへの送信競合を避けて停止する。
    if (!isActiveRuntime(runtime)) return;
    const loop = currentLoop(runtime);
    if (!loop || TERMINAL.has(loop.status) || UNSCHEDULABLE.has(loop.status)) return;
    if ((loop.status === "queued" || loop.status === "verifying_completed") && loop.nextTurnAt) {
      const nextTurnAt = Date.parse(loop.nextTurnAt);
      if (Number.isFinite(nextTurnAt) && Date.now() < nextTurnAt) {
        schedule(runtime, Math.min(MAX_TIMER_DELAY_MS, Math.max(250, nextTurnAt - Date.now())));
        return;
      }
    }
    if (!runtime.ctx.isIdle() || runtime.ctx.hasPendingMessages()) {
      schedule(runtime, 500);
      return;
    }
    // prepare/routing await leaves awaitingTurn false; without this gate a second
    // schedule tick can start another sendTurn and double-count turns.
    if (runtime.sendTurnInFlight) {
      schedule(runtime, 500);
      return;
    }
    runtime.sendTurnInFlight = true;
    // sendTurn内のthrowはvoid化されると未処理rejectでWebUIサーバごと落ちる。
    // 回復可能な形（一時停止→再開）に倒しておく。
    sendTurn(runtime)
      .catch((error) => {
        console.error("[goal-loop] sendTurn failed:", error);
        if (!isActiveRuntime(runtime)) return;
        pauseLoop(
          runtime,
          "scheduler_error",
          `ターンの送信中にエラーが発生しました。${
            error instanceof Error ? ` ${error.message}` : ` ${String(error)}`
          }`,
        );
      })
      .finally(() => {
        runtime.sendTurnInFlight = false;
      });
  }, delay);
  runtime.timer.unref?.();
}

/**
 * Safety net for the scheduler's invariant: a live loop that is not mid-turn
 * must have an armed timer. A settle race (a replaced runtime applied the turn
 * result after the successor's session_start) or a lost settlement can leave
 * queued/verifying_completed on disk with no timer, which silently skips the
 * completion-verification turn until the user pauses and resumes. Re-arm here.
 */
function ensureScheduled(runtime: Runtime): void {
  if (!isActiveRuntime(runtime)) {
    // A replaced runtime never owns the session again; stop watching it.
    if (runtime.watchdogTimer) clearInterval(runtime.watchdogTimer);
    runtime.watchdogTimer = undefined;
    return;
  }
  if (
    runtime.timer ||
    runtime.awaitingTurn ||
    runtime.sendTurnInFlight ||
    !runtime.ctx.isIdle() ||
    runtime.ctx.hasPendingMessages()
  ) {
    return;
  }
  const loop = currentLoop(runtime);
  if (!loop || TERMINAL.has(loop.status) || UNSCHEDULABLE.has(loop.status)) return;
  if (loop.status === "running") {
    // The run is gone but its settlement never landed: fall back to the status
    // the settle would have produced so the next turn is still sent.
    loop.status = loop.turnKind === "verification" ? "verifying_completed" : "queued";
    loop.nextTurnAt = null;
    if (!writeLoop(loop)) return;
    updateUI(runtime, loop);
    appendSnapshot(runtime, loop);
  }
  if (loop.status === "queued" || loop.status === "verifying_completed") schedule(runtime);
}

function startScheduleWatchdog(runtime: Runtime): void {
  if (runtime.watchdogTimer) return;
  runtime.watchdogTimer = setInterval(() => ensureScheduled(runtime), scheduleWatchdogMs());
  runtime.watchdogTimer.unref?.();
}

async function sendTurn(runtime: Runtime): Promise<void> {
  if (!isActiveRuntime(runtime) || runtime.awaitingTurn) return;
  const turnGeneration = runtime.turnGeneration;
  let loop = currentLoop(runtime);
  if (!loop || TERMINAL.has(loop.status) || UNSCHEDULABLE.has(loop.status)) return;

  // Repair corrupt full-run state that still points at verification.
  if (loop.forceFullRun && (loop.status === "verifying_completed" || loop.turnKind === "verification")) {
    loop.status = loop.status === "verifying_completed" ? "queued" : loop.status;
    loop.turnKind = "goal";
    // Persist before continuing. A failed write leaves disk on verification; do
    // not send with a locally repaired object that currentLoop() would reload away.
    if (!writeLoop(loop)) {
      schedule(runtime, 500);
      return;
    }
    if (UNSCHEDULABLE.has(loop.status) || TERMINAL.has(loop.status)) return;
  }

  if (loop.status === "queued") {
    const retryingUnreadableResult = loop.unreadableStreak === 1;
    if (loop.maxTurns > 0 && loop.turnCount >= loop.maxTurns && !retryingUnreadableResult) {
      loop.status = "paused";
      loop.pauseReason = "turn_limit";
      loop.error = "最大ターン数に到達したため一時停止しました。";
      if (!writeLoop(loop)) {
        // Keep disk queued and re-arm so the limit pause can be persisted later.
        schedule(runtime, 500);
        return;
      }
      updateUI(runtime, loop);
      return;
    }
  }

  const routingTurn = loop.status === "queued"
    ? loop.unreadableStreak === 1
      ? loop.turnCount
      : loop.turnCount + 1
    : loop.turnCount;
  const routingPrompt = loop.status === "verifying_completed"
    ? buildVerificationPrompt(loop)
    : routingTurn === 1 && loop.unreadableStreak === 0
      ? buildGoalPrompt(loop, routingTurn)
      : buildGoalContinuationPrompt(loop, routingTurn);
  const prepareGoalLoopTurn = runtime.ctx.prepareGoalLoopTurn;
  if (prepareGoalLoopTurn) {
    try {
      const prepared = await prepareGoalLoopTurn(routingPrompt);
      // startLoop may have replaced this turn while prepare awaited. Ignore
      // stale prepare outcomes so we do not pause/schedule the new loop.
      // Session replacement without session_shutdown also leaves this runtime
      // alive; refuse to act once another runtime owns the key.
      if (!isActiveRuntime(runtime) || runtime.turnGeneration !== turnGeneration) return;
      if (prepared === false) {
        // Routing replaced this session. The new session_start should have
        // re-armed queued/verifying work. If we are somehow still the active
        // runtime for this key, re-arm here so prepare:false cannot leave the
        // loop queued with no timer.
        if (isActiveRuntime(runtime)) {
          const current = currentLoop(runtime);
          if (current && (current.status === "queued" || current.status === "verifying_completed")) {
            schedule(runtime, 250);
          }
        }
        return;
      }
      if (prepared === "retry") {
        schedule(runtime, 250);
        return;
      }
    } catch (error) {
      if (!isActiveRuntime(runtime) || runtime.turnGeneration !== turnGeneration) return;
      pauseLoop(
        runtime,
        "scheduler_error",
        `ターン開始前のルーティング準備に失敗しました。${
          error instanceof Error ? ` ${error.message}` : ` ${String(error)}`
        }`,
      );
      return;
    }
    loop = currentLoop(runtime);
    if (!loop || TERMINAL.has(loop.status) || UNSCHEDULABLE.has(loop.status)) return;
    if (!runtime.ctx.isIdle() || runtime.ctx.hasPendingMessages()) {
      schedule(runtime, 500);
      return;
    }
  }

  let prompt: string;
  let kind: GoalLoopTurnKind;
  let uiPrompt: string | undefined;
  let isInitialTurn = false;
  if (loop.status === "queued") {
    const retryingUnreadableResult = loop.unreadableStreak === 1;
    if (loop.maxTurns > 0 && loop.turnCount >= loop.maxTurns && !retryingUnreadableResult) {
      loop.status = "paused";
      loop.pauseReason = "turn_limit";
      loop.error = "最大ターン数に到達したため一時停止しました。";
      if (!writeLoop(loop)) {
        schedule(runtime, 500);
        return;
      }
      updateUI(runtime, loop);
      return;
    }
    if (!retryingUnreadableResult) loop.turnCount += 1;
    loop.status = "running";
    loop.turnKind = "goal";
    loop.nextTurnAt = null;
    kind = "goal";
    isInitialTurn = loop.turnCount === 1 && !retryingUnreadableResult;
    prompt = isInitialTurn
      ? buildGoalPrompt(loop, loop.turnCount)
      : buildGoalContinuationPrompt(loop, loop.turnCount);
    // Keep the full prompt in the LLM context, but expose only the original
    // goal text to the WebUI as a user-facing message.
    if (isInitialTurn) uiPrompt = loop.goal;
  } else if (loop.status === "verifying_completed") {
    loop.status = "running";
    loop.turnKind = "verification";
    loop.nextTurnAt = null;
    kind = "verification";
    prompt = buildVerificationPrompt(loop);
  } else {
    return;
  }

  // Persist running/turnCount before send. On failure disk still has the pre-send
  // queued state; never set awaitingTurn or enqueue a prompt against stale disk.
  if (!writeLoop(loop)) {
    schedule(runtime, 500);
    return;
  }
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  runtime.awaitingTurn = true;
  runtime.pausedTurnPending = false;
  runtime.abortedTurnPausePending = false;
  runtime.pendingAgentMessages = undefined;
  runtime.pendingAgentAborted = false;
  runtime.awaitingTurnIndex = undefined;
  runtime.pausedTurnIndex = undefined;
  if (runtime.timeoutTimer) clearTimeout(runtime.timeoutTimer);
  runtime.timeoutTimer = setTimeout(() => {
    // After a dispose()-without-shutdown replacement, the new session may be
    // running again. A stale watchdog must not pause the shared loop state.
    if (!isActiveRuntime(runtime)) return;
    const current = currentLoop(runtime);
    if (runtime.awaitingTurn && current?.status === "running") {
      if (!pauseLoop(runtime, "turn_timeout", "応答が確認できないまま時間切れになったため一時停止しました。")) {
        return;
      }
      // Match user pause: stop the in-flight model run so a hung tool/stream
      // cannot keep consuming tokens after the loop is already paused.
      try {
        if (!runtime.ctx.isIdle()) runtime.ctx.abort();
      } catch {
        // Already settled.
      }
    }
  }, turnTimeoutMs());
  runtime.timeoutTimer.unref?.();

  try {
    runtime.pi.sendMessage(
      {
        customType: kind === "verification" ? "leafcode-goal-verification" : "leafcode-goal-turn",
        content: isInitialTurn && loop.initialImages?.length
          ? [{ type: "text" as const, text: prompt }, ...loop.initialImages]
          : prompt,
        // Keep the raw prompt hidden in TUI and let the WebUI project only
        // the explicit user-facing text from details.uiPrompt.
        display: false,
        details: {
          goalId: loop.id,
          turn: loop.turnCount,
          kind,
          forceFullRun: loop.forceFullRun,
          ...(uiPrompt !== undefined ? { uiPrompt } : {}),
        },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    if (isInitialTurn && loop.initialImages?.length) {
      delete loop.initialImages;
      writeLoop(loop);
    }
  } catch (error) {
    clearTimer(runtime);
    // sendMessage may throw after we already flipped to running/awaitingTurn.
    // Always leave a paused unknown_delivery state — never stay running with a
    // live awaitingTurn flag after a delivery exception.
    const current = currentLoop(runtime);
    if (current && !TERMINAL.has(current.status) && current.status !== "blocked") {
      // sendMessage() is a non-idempotent enqueue. A synchronous exception can
      // still occur after the runtime accepted the message, so never roll back
      // the turn and retry automatically. Pause until the user explicitly
      // resumes, matching LeafCode's unknown-delivery contract.
      if (current.status !== "paused" || current.pauseReason !== "unknown_delivery") {
        pauseLoop(
          runtime,
          "unknown_delivery",
          `プロンプトの送達を確認できないため、重複送信を防止して一時停止しました。${
            error instanceof Error ? ` ${error.message}` : ` ${String(error)}`
          }`,
        );
      } else {
        runtime.awaitingTurn = false;
        runtime.awaitingTurnIndex = undefined;
      }
    } else {
      runtime.awaitingTurn = false;
      runtime.awaitingTurnIndex = undefined;
    }
  }
}

function startLoop(
  runtime: Runtime,
  config: {
    goal: string;
    acceptance?: unknown;
    maxTurns?: unknown;
    cooldownSeconds?: unknown;
    forceFullRun?: unknown;
    autoAgent?: unknown;
    initialImages?: unknown;
  },
): GoalLoop | null {
  const goal = config.goal.trim().slice(0, MAX_GOAL_CHARS);
  const acceptance = normalizeAcceptance(config.acceptance);
  if (!goal || !acceptance) return null;

  const previous = currentLoop(runtime);
  const replacingLiveLoop = !!previous && !TERMINAL.has(previous.status);
  const now = isoNow();
  const loop: GoalLoop = {
    id: runtime.sessionId,
    sessionId: runtime.sessionId,
    cwd: runtime.cwd,
    status: "queued",
    goal,
    acceptance,
    maxTurns: clampMaxTurns(config.maxTurns),
    cooldownSeconds: clampCooldownSeconds(config.cooldownSeconds),
    nextTurnAt: null,
    forceFullRun: config.forceFullRun === true,
    autoAgent: config.autoAgent === true,
    initialImages: normalizeInitialImages(config.initialImages),
    turnCount: 0,
    turnKind: "goal",
    pauseReason: "",
    error: "",
    progress: [],
    summary: "",
    evidence: "",
    blockedReason: "",
    rejectedClaims: 0,
    unreadableStreak: 0,
    pendingTurnRecovery: false,
    createdAt: now,
    updatedAt: now,
  };
  // Keep the prior runtime untouched until this replacement is durable. A
  // failed new write must not stop a working loop or invalidate its routing.
  if (!writeLoop(loop)) return null;

  // The new state is durable. Now invalidate/abort any old in-flight turn so a
  // trailing settlement cannot apply to this loop.
  runtime.endNoticeQueued = false;
  runtime.turnGeneration += 1;
  const expectTrailingSettlement = replacingLiveLoop &&
    (runtime.pausedTurnPending || !runtime.ctx.isIdle());
  clearTimer(runtime);
  runtime.awaitingTurn = false;
  runtime.awaitingTurnIndex = undefined;
  runtime.pausedTurnPending = false;
  runtime.pausedTurnIndex = undefined;
  runtime.sendTurnInFlight = false;
  clearPendingAgentRun(runtime);
  if (replacingLiveLoop) {
    try {
      if (!runtime.ctx.isIdle()) runtime.ctx.abort();
    } catch {
      // The previous run may already have settled.
    }
    if (expectTrailingSettlement) runtime.discardAgentSettlements = 1;
  }
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  schedule(runtime, 0);
  return loop;
}

function parseStartArgs(args: string): {
  goal: string;
  maxTurns: number;
  cooldownSeconds: number;
  forceFullRun: boolean;
  acceptance: string[];
} {
  let text = args.trim();
  let forceFullRun = false;
  let maxTurns = DEFAULT_MAX_TURNS;
  let cooldownSeconds = DEFAULT_COOLDOWN_SECONDS;
  let acceptance: string[] = [];

  if (/(?:^|\s)--(?:full-run|完走)(?=\s|$)/i.test(text)) {
    forceFullRun = true;
    text = text.replace(/(?:^|\s)--(?:full-run|完走)(?=\s|$)/gi, " ");
  }
  const turns = text.match(/(?:^|\s)--(?:turns|max-turns)\s+([+-]?\d+)/i);
  if (turns) {
    maxTurns = clampMaxTurns(turns[1]);
    text = text.replace(turns[0], " ");
  }
  const cooldownFlag = text.match(/(?:^|\s)--cooldown\s+("[^"]*"|'[^']*'|\S+)/i);
  if (cooldownFlag) {
    const value = cooldownFlag[1].replace(/^["']|["']$/g, "");
    cooldownSeconds = parseCooldownSeconds(value);
    text = text.replace(cooldownFlag[0], " ");
  }
  const acceptanceFlag = text.match(/(?:^|\s)--acceptance(?:=|\s+)("[^"]*"|'[^']*'|\S+)/i);
  if (acceptanceFlag) {
    const value = acceptanceFlag[1].replace(/^("|')|("|')$/g, "");
    acceptance = normalizeAcceptance(value.replace(/\\n/g, "\n")) ?? [];
    text = text.replace(acceptanceFlag[0], " ");
  }
  return { goal: text.replace(/\s+/g, " ").trim(), maxTurns, cooldownSeconds, forceFullRun, acceptance };
}

async function compose(runtime: Runtime): Promise<void> {
  const turnGeneration = runtime.turnGeneration;
  if (!runtime.ctx.hasUI) {
    runtime.ctx.ui.notify("Composer は TUI/RPC モードで利用できます。/goal --full-run --turns 10 <goal> を使用してください。", "warning");
    return;
  }
  const goal = await runtime.ctx.ui.input("Goal", "達成したい目的を入力");
  if (!goal?.trim()) return;
  const acceptance = runtime.ctx.mode === "tui"
    ? await runtime.ctx.ui.editor("承認条件（任意・1行に1つ）", "")
    : await runtime.ctx.ui.input("承認条件（任意・改行区切り）", "例: npm test が成功");
  const maxTurnsText = await runtime.ctx.ui.input("最大ターン数", String(DEFAULT_MAX_TURNS));
  const cooldownText = await runtime.ctx.ui.input("クールタイム", "0");
  const forceFullRun = await runtime.ctx.ui.confirm(
    "完走モード",
    "完了宣言を使わず、指定した最大ターン数まで必ず実行します。",
  );
  // The dialog may outlive this session or a newer start on the same runtime.
  if (!isActiveRuntime(runtime) || runtime.turnGeneration !== turnGeneration) return;
  const maxTurns = clampMaxTurns(maxTurnsText || DEFAULT_MAX_TURNS);
  const loop = startLoop(runtime, {
    goal,
    acceptance: acceptance ?? "",
    maxTurns,
    cooldownSeconds: parseCooldownSeconds(cooldownText),
    forceFullRun,
  });
  if (loop) {
    runtime.ctx.ui.notify(`Goal loop started (${maxTurns}ターン${forceFullRun ? "・完走" : ""})`, "info");
  } else {
    runtime.ctx.ui.notify("Goal loop を開始できませんでした（パラメータ不正または状態保存失敗）。", "error");
  }
}

function statusMessage(loop: GoalLoop | null): string {
  if (!loop) return "Goal loop はありません。/goal-compose で作成できます。";
  const turn = loop.status === "queued" ? loop.turnCount + 1 : loop.turnCount;
  const max = loop.maxTurns === 0 ? "∞" : String(loop.maxTurns);
  const shownTurn = loop.maxTurns === 0 ? turn : Math.min(turn, loop.maxTurns);
  const mode = loop.forceFullRun ? " · 完走モード" : "";
  const detail = loop.error || loop.blockedReason ? ` · ${loop.error || loop.blockedReason}` : "";
  return `${statusLabel(loop.status)} ${shownTurn}/${max}${mode} · ${short(loop.goal, 140)}${detail}`;
}

function resumeLoop(runtime: Runtime, maxTurns?: unknown): boolean {
  const loop = currentLoop(runtime);
  if (!loop || (loop.status !== "paused" && loop.status !== "blocked")) {
    runtime.ctx.ui.notify("一時停止中または要対応の Goal loop はありません。", "info");
    return false;
  }
  if (maxTurns !== undefined) {
    const requestedMaxTurns = clampMaxTurns(maxTurns);
    loop.maxTurns = requestedMaxTurns === 0
      ? 0
      : Math.max(loop.maxTurns, requestedMaxTurns);
  }
  if (loop.maxTurns > 0 && loop.turnCount >= loop.maxTurns) {
    // A final-turn JSON miss pauses as unreadable_result after the free retry.
    // Allow one more non-consuming send (streak===1) instead of forcing the
    // user to raise the turn budget just to recover from a formatting miss.
    if (loop.pauseReason === "unreadable_result") {
      loop.unreadableStreak = 1;
    } else {
      runtime.ctx.ui.notify("最大ターン数を増やしてから再開してください。例: /goal-resume --turns 20", "warning");
      // Persist any maxTurns bump from this resume attempt; ignore failure beyond
      // keeping disk unchanged so the user can retry with a higher budget.
      if (!writeLoop(loop)) {
        runtime.ctx.ui.notify("状態の保存に失敗しました。", "error");
      }
      updateUI(runtime, currentLoop(runtime));
      return false;
    }
  } else {
    // User-initiated resume starts a fresh miss streak so the first missing
    // JSON after resume still gets the one free retry.
    loop.unreadableStreak = 0;
  }
  if (runtime.pausedTurnPending || loop.pendingTurnRecovery) {
    const recovered = lateTurnResult(runtime, loop);
    if (recovered) {
      runtime.pausedTurnPending = false;
      runtime.pausedTurnIndex = undefined;
      loop.pendingTurnRecovery = false;
      loop.status = "running";
      loop.endNoticeSent = false;
      if (!applyResult(loop, recovered)) {
        runtime.pausedTurnPending = true;
        runtime.ctx.ui.notify("結果の保存に失敗したため再開を中止しました。再試行してください。", "error");
        return false;
      }
      const updated = currentLoop(runtime);
      if (!updated || updated.pendingTurnRecovery) {
        runtime.pausedTurnPending = true;
        runtime.ctx.ui.notify("結果の保存に失敗したため再開を中止しました。再試行してください。", "error");
        return false;
      }
      updateUI(runtime, updated);
      appendSnapshot(runtime, updated);
      // turn_end recovery relies on a later agent_settled to re-arm the
      // scheduler. Resume recovery often happens after settlement, so arm it
      // here or the loop stays queued forever.
      if (updated.status === "queued" || updated.status === "verifying_completed") {
        schedule(runtime);
      } else {
        notifyLoopEnded(runtime);
      }
      return true;
    }
    if (loop.pauseReason === "unknown_delivery") {
      // Keep pendingTurnRecovery so a later resume can still pick up a real
      // transcript result for THIS turnCount if delivery actually happened.
      runtime.ctx.ui.notify("送達が確認できないため再送しません。新しい Goal loop を開始してください。", "warning");
      if (!writeLoop(loop)) {
        runtime.ctx.ui.notify("状態の保存に失敗しました。", "error");
        updateUI(runtime, currentLoop(runtime));
        return false;
      }
      updateUI(runtime, loop);
      return false;
    }
    runtime.pausedTurnPending = false;
    runtime.pausedTurnIndex = undefined;
    loop.pendingTurnRecovery = false;
  }
  // Lifecycle pauses (pauseReason "") keep absolute nextTurnAt on disk so a
  // shutdown mid-cooldown does not silently shorten the wait on /goal-resume.
  // User/manual pauses already cleared nextTurnAt in pauseLoop.
  const preserveCooldown =
    loop.pauseReason === "" &&
    typeof loop.nextTurnAt === "string" &&
    Number.isFinite(Date.parse(loop.nextTurnAt)) &&
    Date.parse(loop.nextTurnAt) > Date.now();
  loop.status = (!loop.forceFullRun && loop.turnKind === "verification") ? "verifying_completed" : "queued";
  if (loop.forceFullRun) loop.turnKind = "goal";
  loop.endNoticeSent = false;
  loop.pauseReason = "";
  loop.error = "";
  loop.blockedReason = "";
  loop.pendingTurnRecovery = false;
  if (!preserveCooldown) loop.nextTurnAt = null;
  if (!writeLoop(loop)) {
    runtime.ctx.ui.notify("状態の保存に失敗したため再開できませんでした。", "error");
    return false;
  }
  runtime.endNoticeQueued = false;
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  schedule(runtime, 0);
  return true;
}

function handleAction(runtime: Runtime, action: "pause" | "resume" | "stop" | "complete", args = ""): void {
  if (action === "pause") {
    const loop = currentLoop(runtime);
    if (!loop) runtime.ctx.ui.notify("Goal loop はありません。", "info");
    else if (loop.status === "blocked") {
      runtime.ctx.ui.notify("要対応中の Goal loop です。対応後に再開または停止できます。", "info");
    } else if (TERMINAL.has(loop.status)) {
      runtime.ctx.ui.notify("Goal loop は既に終了しています。", "info");
    } else if (!pauseLoop(runtime)) {
      runtime.ctx.ui.notify("一時停止状態の保存に失敗しました。再試行してください。", "error");
    } else {
      try {
        if (!runtime.ctx.isIdle()) runtime.ctx.abort();
      } catch {
        // Already settled.
      }
      runtime.ctx.ui.notify("Goal loop を一時停止しました。", "info");
    }
    return;
  }
  if (action === "stop") {
    const loop = currentLoop(runtime);
    if (!loop) runtime.ctx.ui.notify("Goal loop はありません。", "info");
    else if (TERMINAL.has(loop.status)) {
      runtime.ctx.ui.notify("Goal loop は既に終了しています。", "info");
    } else if (!stopLoop(runtime)) {
      runtime.ctx.ui.notify("停止状態の保存に失敗しました。再試行してください。", "error");
    } else {
      runtime.ctx.ui.notify("Goal loop を停止しました。", "info");
    }
    return;
  }
  if (action === "complete") {
    const completed = completeLoop(runtime);
    if (completed) {
      runtime.ctx.ui.notify("Goal loop を完了しました。新しい Goal loop を開始できます。", "info");
      return;
    }
    const loop = currentLoop(runtime);
    // A failed write leaves the eligible state on disk; don't report it as missing.
    const eligible =
      !!loop &&
      (loop.status === "blocked" ||
        (loop.status === "paused" &&
          loop.pauseReason === "turn_limit" &&
          loop.maxTurns > 0 &&
          loop.turnCount >= loop.maxTurns));
    runtime.ctx.ui.notify(
      eligible
        ? "完了状態の保存に失敗しました。再試行してください。"
        : "最大ターン数に到達した一時停止中の Goal loop、または要対応中の Goal loop はありません。",
      eligible ? "error" : "warning",
    );
    return;
  }
  const turnFlag = /(?:^|\s)--(?:turns|max-turns)(?=\s|$)/i.test(args);
  const turns = args.match(/--(?:turns|max-turns)\s+([+-]?\d+)/i)?.[1];
  if (turnFlag && turns === undefined) {
    runtime.ctx.ui.notify("再開ターン数が不正です。例: /goal-resume --turns 20", "warning");
    return;
  }
  if (resumeLoop(runtime, turns)) runtime.ctx.ui.notify("Goal loop を再開しました。", "info");
}

function decodeStartConfig(args: string): {
  goal: string;
  acceptance?: unknown;
  maxTurns?: unknown;
  cooldownSeconds?: unknown;
  forceFullRun?: unknown;
  autoAgent?: unknown;
  initialImages?: unknown;
} | null {
  try {
    const decoded = Buffer.from(args.trim(), "base64url").toString("utf8");
    const raw = asRecord(JSON.parse(decoded));
    if (!raw || typeof raw.goal !== "string") return null;
    return {
      goal: raw.goal,
      acceptance: raw.acceptance,
      maxTurns: raw.maxTurns,
      cooldownSeconds: raw.cooldownSeconds,
      forceFullRun: raw.forceFullRun,
      autoAgent: raw.autoAgent,
      initialImages: raw.images,
    };
  } catch {
    return null;
  }
}

function registerCommandAliases(pi: ExtensionAPI, getRuntime: () => Runtime | null): void {
  const runtimeForContext = (ctx: ExtensionContext): Runtime | null => {
    const runtime = getRuntime();
    return runtime && matchesRuntimeContext(runtime, ctx) ? runtime : null;
  };
  pi.registerCommand("goal-start", {
    description: "JSON/base64 形式で Goal loop を開始（Web Composer 用）",
    handler: async (args, ctx) => {
      const runtime = runtimeForContext(ctx);
      const config = decodeStartConfig(args);
      if (!runtime || !config) {
        ctx.ui.notify("Goal loop の開始パラメータが不正です。", "error");
        return;
      }
      const loop = startLoop(runtime, config);
      if (!loop) {
        ctx.ui.notify("Goal loop を開始できませんでした（パラメータ不正または状態保存失敗）。", "error");
        return;
      }
      ctx.ui.notify(`Goal loop started: ${loop.maxTurns === 0 ? "無制限" : `${loop.maxTurns}ターン`}${loop.forceFullRun ? "・完走" : ""}`, "info");
    },
  });
  pi.registerCommand("goal-set", {
    description: "Goal loop を引数で開始",
    handler: async (args, ctx) => {
      const runtime = runtimeForContext(ctx);
      if (!runtime) return;
      const config = parseStartArgs(args);
      const loop = startLoop(runtime, config);
      if (!loop) ctx.ui.notify("Goal loop を開始できませんでした（パラメータ不正または状態保存失敗）。", "error");
    },
  });
  pi.registerCommand("goal-status", {
    description: "Goal loop の状態を表示",
    handler: async (_args, ctx) => {
      const runtime = runtimeForContext(ctx);
      if (runtime) ctx.ui.notify(statusMessage(currentLoop(runtime)), "info");
    },
  });
  pi.registerCommand("goal-pause", {
    description: "Goal loop を一時停止",
    handler: async (args, ctx) => {
      const runtime = runtimeForContext(ctx);
      if (runtime) handleAction(runtime, "pause", args);
    },
  });
  pi.registerCommand("goal-resume", {
    description: "Goal loop を再開",
    handler: async (args, ctx) => {
      const runtime = runtimeForContext(ctx);
      if (runtime) handleAction(runtime, "resume", args);
    },
  });
  pi.registerCommand("goal-stop", {
    description: "Goal loop を停止",
    handler: async (_args, ctx) => {
      const runtime = runtimeForContext(ctx);
      if (runtime) handleAction(runtime, "stop");
    },
  });
  pi.registerCommand("goal-complete", {
    description: "要対応中または最大ターン数に到達した Goal loop を完了",
    handler: async (_args, ctx) => {
      const runtime = runtimeForContext(ctx);
      if (runtime) handleAction(runtime, "complete");
    },
  });
  pi.registerCommand("goal-compose", {
    description: "Goal / 承認条件 / 最大ターン / 完走モードを設定する Composer",
    handler: async (_args, ctx) => {
      const runtime = runtimeForContext(ctx);
      if (runtime) await compose(runtime);
    },
  });
}

export default function (pi: ExtensionAPI): void {
  // session_start は factory の直後に来るため、runtime はイベント内で作る。
  let runtime: Runtime | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const id = sessionId(ctx);
    const key = runtimeKey(ctx.cwd, id);
    // A single extension instance can receive a new session_start before the
    // old session_shutdown. Retire the prior runtime so its timers cannot act
    // on the old context after this closure begins targeting the new session.
    if (runtime && !runtime.disposed) {
      // Switching to a different session does not necessarily emit the old
      // session_shutdown. Persist the same lifecycle pause here so its queued
      // or running loop cannot silently resume while this extension is away.
      if (isActiveRuntime(runtime) && runtime.key !== key) {
        const previousLoop = currentLoop(runtime);
        if (
          previousLoop &&
          (
            previousLoop.status === "running" ||
            previousLoop.status === "queued" ||
            previousLoop.status === "verifying_completed" ||
            isAbortPausedLoop(previousLoop)
          )
        ) {
          if (previousLoop.status === "running") previousLoop.pendingTurnRecovery = true;
          previousLoop.status = "paused";
          previousLoop.pauseReason = "";
          previousLoop.error = "セッション切替時に一時停止しました。";
          if (!writeLoop(previousLoop)) {
            console.error("[goal-loop] session switch failed to persist lifecycle pause");
          }
        }
      }
      runtime.disposed = true;
      clearPendingAgentRun(runtime);
      clearTimer(runtime);
      if (runtime.watchdogTimer) clearInterval(runtime.watchdogTimer);
      runtime.watchdogTimer = undefined;
      if (runtimes.get(runtime.key) === runtime) runtimes.delete(runtime.key);
    }
    runtime = {
      key,
      cwd: ctx.cwd,
      sessionId: id,
      ctx,
      sessionManager: ctx.sessionManager,
      pi,
      awaitingTurn: false,
      turnGeneration: 0,
      pausedTurnPending: false,
      pausedTurnIndex: undefined,
      discardAgentSettlements: 0,
      sendTurnInFlight: false,
      abortedTurnPausePending: false,
      endNoticeQueued: false,
      disposed: false,
      pendingAgentAborted: false,
    };
    runtimes.set(key, runtime);
    startScheduleWatchdog(runtime);

    const loop = currentLoop(runtime);
    if (loop?.status === "running" || isAbortPausedLoop(loop)) {
      // Only running has an in-flight prompt that needs manual recovery. An
      // abort pause can be left on disk when the following lifecycle write
      // fails; normalize that internal pause before exposing the new session.
      if (loop.status === "running") loop.pendingTurnRecovery = true;
      loop.status = "paused";
      loop.pauseReason = "";
      loop.error = "セッション再開時は自動継続しません。/goal-resume で再開してください。";
      // Persist before arming pausedTurnPending. A failed write must not claim
      // recovery against disk that is still mid-turn running.
      if (!writeLoop(loop)) {
        ctx.ui.notify("セッション再開時の状態保存に失敗しました。再接続してから /goal-resume を試してください。", "error");
      } else {
        runtime.pausedTurnPending = loop.pendingTurnRecovery;
      }
    }
    const fresh = currentLoop(runtime);
    updateUI(runtime, fresh);
    if (fresh?.status === "queued" || fresh?.status === "verifying_completed") {
      // The persisted absolute cooldown must survive extension/session reloads.
      schedule(runtime, 0);
    } else {
      // Lifecycle pause is persisted directly during shutdown, so it has not
      // passed through pauseLoop() to queue the prompt-contract end notice.
      notifyLoopEnded(runtime);
    }
  });

  const getRuntime = (): Runtime | null => runtime && isActiveRuntime(runtime) ? runtime : null;

  // 追加送信はループを止めない: input では pause も abort もしない。実行中ターンには
  // steer/followUp として注入され、ターン間なら通常ターンとして走り、ループは idle を
  // 待って自動継続する（schedule と prepareGoalLoopTurn が busy 中は送信しないため、
  // 追加送信とループの次ターンは混ざらない）。止めたいときは /goal-pause か Stop を使う。
  // ここでは同時に、その指示を以降のターンのプロンプトへ載せるために記録する。
  pi.on("input", async (event, ctx) => {
    const current = getRuntime();
    // Delayed input from a replaced session must not become an operator note
    // on the runtime installed by the newer session_start.
    if (
      !current ||
      !matchesRuntimeContext(current, ctx) ||
      event.source === "extension"
    ) return;
    // 拡張コマンドは input の前に処理されるが、/goal-* を追加指示として記録しない。
    if (/^\/(?:goal|goal-status|goal-pause|goal-resume|goal-stop|goal-complete|goal-compose)(?:\s|$)/i.test(event.text)) return;
    const loop = currentLoop(current);
    if (!loop || TERMINAL.has(loop.status) || UNSCHEDULABLE.has(loop.status)) return;
    recordOperatorNote(current, loop, event.text);
  });

  pi.on("turn_start", async (event, ctx) => {
    const current = getRuntime();
    if (!current || !matchesRuntimeContext(current, ctx)) return;
    if (current.awaitingTurn) current.awaitingTurnIndex = event.turnIndex;
  });

  pi.on("turn_end", async (event, ctx) => {
    const current = getRuntime();
    if (!current || !matchesRuntimeContext(current, ctx)) return;
    const loop = currentLoop(current);
    if (!loop) return;

    if (
      !current.awaitingTurn &&
      current.pausedTurnPending &&
      loop.status === "paused" &&
      // Tool-using runs emit multiple turnIndices. Accept this turn and later
      // ones from the interrupted run; also allow recovery when turn_start never
      // armed pausedTurnIndex before the pause.
      (current.pausedTurnIndex === undefined || event.turnIndex >= current.pausedTurnIndex)
    ) {
      const result = extractGoalResult(assistantText(event.message));
      if (!result) return;
      applyLatePausedResult(current, result);
      return;
    }
    // `turn_end` fires once per assistant/tool iteration. A tool call normally
    // has no Goal JSON yet; agent_end records the latest run result and
    // agent_settled applies it after retries and compaction have finished.
  });

  pi.on("agent_end", async (event, ctx) => {
    const current = getRuntime();
    // Agent events can arrive after session_start installed another runtime.
    // Never let the preceding session's result settle the new loop.
    if (!current || !matchesRuntimeContext(current, ctx)) return;
    // Trailing end from an aborted/replaced run — do not poison a newer await.
    if (current.discardAgentSettlements > 0) return;
    // After a mid-turn pause, awaitingTurn is false but we still need the final
    // messages so agent_settled can recover JSON (manual_send/abort races).
    if (!current.awaitingTurn && !current.pausedTurnPending) return;
    current.pendingAgentMessages = event.messages;
    current.pendingAgentAborted = event.messages.some(isAbortedAssistant) || Boolean(ctx.signal?.aborted);
  });

  pi.on("session_compact", async (event, ctx) => {
    const current = getRuntime();
    if (
      current &&
      matchesRuntimeContext(current, ctx) &&
      event.reason === "manual"
    ) requeueAfterManualCompaction(current);
  });

  pi.on("session_compact_failed", async (event, ctx) => {
    const current = getRuntime();
    if (
      current &&
      matchesRuntimeContext(current, ctx) &&
      event.reason === "manual"
    ) requeueAfterManualCompaction(current);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const current = getRuntime();
    if (!current || current.key !== runtimeKey(ctx.cwd, sessionId(ctx))) return;
    if (!matchesRuntimeContext(current, ctx)) {
      // startLoop can arm one discard slot for the predecessor's final settle.
      // Consume that stale wave without allowing it to settle the replacement.
      if (current.discardAgentSettlements > 0) current.discardAgentSettlements -= 1;
      return;
    }
    const loop = currentLoop(current);
    if (!loop) {
      clearPendingAgentRun(current);
      return;
    }
    if (TERMINAL.has(loop.status) || loop.status === "blocked") {
      // Ignore delayed events after stop/complete/blocked; also clear any stuck
      // awaitingTurn so a later goal-start cannot hang on the send gate.
      if (current.discardAgentSettlements > 0) current.discardAgentSettlements -= 1;
      clearPendingAgentRun(current);
      current.awaitingTurn = false;
      current.awaitingTurnIndex = undefined;
      current.pausedTurnPending = false;
      current.pausedTurnIndex = undefined;
      return;
    }
    if (current.discardAgentSettlements > 0) {
      current.discardAgentSettlements -= 1;
      clearPendingAgentRun(current);
      // A replacement may already be awaiting; do not settle it with this wave.
      if (current.awaitingTurn && loop.status === "running") return;
      if (loop.status === "queued" || loop.status === "verifying_completed") schedule(current);
      return;
    }
    if (current.awaitingTurn) {
      // settleAwaitingTurn also clears a stale await when durable state was
      // replaced before this delayed event arrived.
      await settleAwaitingTurn(current);
      return;
    }
    if (current.pausedTurnPending && loop.status === "paused") {
      const result = extractGoalResultFromMessages(current.pendingAgentMessages ?? []);
      clearPendingAgentRun(current);
      if (result) applyLatePausedResult(current, result);
      return;
    }
    clearPendingAgentRun(current);
    if (loop.status === "queued" || loop.status === "verifying_completed") schedule(current);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Superseded runtimes must still release their timers, without changing disk.
    const current = runtime;
    // Ignore teardown from the preceding session when its session_start has
    // already installed a different runtime in this extension instance.
    if (!current || current.disposed || !matchesRuntimeContext(current, ctx)) return;
    // A replacement can reuse the same cwd/session ID. In that case a delayed
    // shutdown carries the old manager and must not dispose the new runtime.
    // dispose()/replace can leave this extension instance alive long enough to
    // see shutdown after a newer runtime already claimed the same key. Never
    // pause the shared loop or delete the replacement's map entry in that case.
    const active = isActiveRuntime(current);
    if (active) {
      const loop = currentLoop(current);
      if (
        loop &&
        (
          loop.status === "running" ||
          loop.status === "queued" ||
          loop.status === "verifying_completed" ||
          (current.abortedTurnPausePending && isAbortPausedLoop(loop))
        )
      ) {
        // An abort settlement can run before teardown emits session_shutdown.
        // Normalize that internal abort pause to a lifecycle pause instead of
        // exposing it as a user action.
        // Persist mid-turn recovery across restart. pausedTurnPending alone dies
        // with this runtime, and the next session_start only sees status=paused.
        if (loop.status === "running") loop.pendingTurnRecovery = true;
        loop.status = "paused";
        loop.pauseReason = "";
        loop.error = "セッション終了時に一時停止しました。";
        // Session is ending either way: dispose below. On write failure leave disk
        // unchanged so the next session_start can repair running or re-arm queued.
        if (!writeLoop(loop)) {
          console.error("[goal-loop] session_shutdown failed to persist lifecycle pause");
        }
        clearTimer(current);
        current.awaitingTurn = false;
      }
    }
    current.abortedTurnPausePending = false;
    current.disposed = true;
    if (current.watchdogTimer) clearInterval(current.watchdogTimer);
    current.watchdogTimer = undefined;
    clearPendingAgentRun(current);
    clearTimer(current);
    if (active) runtimes.delete(current.key);
  });

  pi.registerCommand("goal", {
    description: "Goal loop を開始。/goal-compose で Composer を開く",
    handler: async (args, ctx) => {
      const current = getRuntime();
      if (!current || !matchesRuntimeContext(current, ctx)) return;
      const text = args.trim();
      if (!text) {
        ctx.ui.notify(statusMessage(currentLoop(current)), "info");
        return;
      }
      const command = text.toLowerCase();
      if (command === "status") {
        ctx.ui.notify(statusMessage(currentLoop(current)), "info");
        return;
      }
      if (command === "pause" || command === "resume" || command === "stop" || command === "complete") {
        handleAction(current, command, "");
        return;
      }
      if (command === "compose") {
        await compose(current);
        return;
      }
      const config = parseStartArgs(text);
      const loop = startLoop(current, config);
      if (!loop) {
        ctx.ui.notify("Goal loop を開始できませんでした（パラメータ不正または状態保存失敗）。", "error");
        return;
      }
      ctx.ui.notify(`Goal loop started: ${config.maxTurns}ターン${config.forceFullRun ? "・完走" : ""}`, "info");
    },
  });

  // Handlers resolve the current session lazily because session_start runs after
  // the extension factory is evaluated.
  registerCommandAliases(pi, getRuntime);
}

// Exposed for small, dependency-free checks.
export const goalLoopTestSeams = {
  normalizeAcceptance,
  normalizeInitialImages,
  jsonObjectCandidates,
  normalizeStructured,
  extractGoalResult,
  extractGoalResultFromMessages,
  buildGoalPrompt,
  buildGoalContinuationPrompt,
  buildVerificationPrompt,
  applyResult,
  applyMissingResult,
  goalStateFile,
  readLoop,
  clampMaxTurns,
  clampCooldownSeconds,
  parseCooldownSeconds,
  parseStartArgs,
  setTurnTimeoutMs(ms?: number) {
    turnTimeoutMsForTests = typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  },
  setScheduleWatchdogMs(ms?: number) {
    scheduleWatchdogMsForTests = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : undefined;
  },
  setRenameSync(fn?: (temp: string, file: string) => void) {
    renameSyncForTests = fn;
  },
  setWriteLoopFail(fail?: boolean) {
    writeLoopFailForTests = fail === true;
  },
  setWriteLoopAllowCount(count?: number) {
    writeLoopAllowCountForTests =
      typeof count === "number" && Number.isFinite(count)
        ? Math.max(0, Math.trunc(count))
        : undefined;
  },
};
