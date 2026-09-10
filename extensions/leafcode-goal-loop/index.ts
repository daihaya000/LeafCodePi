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
const MAX_REJECTED_CLAIMS = 2;
const MAX_UNREADABLE_STREAK = 2;
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const TERMINAL = new Set<GoalLoopStatus>(["completed", "blocked", "stopped"]);

const runtimes = new Map<string, Runtime>();
/** Test-only override for the in-flight turn watchdog. */
let turnTimeoutMsForTests: number | undefined;
/** Test-only override for atomic state rename. */
let renameSyncForTests: ((temp: string, file: string) => void) | undefined;
/** Test-only: force writeLoop to fail without touching disk. */
let writeLoopFailForTests = false;

function isActiveRuntime(runtime: Runtime): boolean {
  return !runtime.disposed && runtimes.get(runtime.key) === runtime;
}

function turnTimeoutMs(): number {
  return turnTimeoutMsForTests ?? TURN_TIMEOUT_MS;
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
  awaitingTurnIndex?: number;
  pausedTurnIndex?: number;
  timer?: ReturnType<typeof setTimeout>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
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

export function safeIdPart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  return safe || "session";
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
  const acceptance = normalizeAcceptance(raw.acceptance);
  if (!acceptance) return null;
  const progress = normalizeProgress(raw.progress);
  const now = isoNow();
  return {
    id,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : id,
    cwd,
    status: normalizeStatus(raw.status),
    goal: raw.goal.slice(0, MAX_GOAL_CHARS),
    acceptance,
    maxTurns: clampMaxTurns(raw.maxTurns),
    cooldownSeconds: clampCooldownSeconds(raw.cooldownSeconds),
    nextTurnAt: normalizeNextTurnAt(raw.nextTurnAt),
    forceFullRun: raw.forceFullRun === true,
    autoAgent: raw.autoAgent === true,
    turnCount: Math.max(0, Math.trunc(Number(raw.turnCount) || 0)),
    turnKind: normalizeTurnKind(raw.turnKind),
    pauseReason: normalizePauseReason(raw.pauseReason),
    error: typeof raw.error === "string" ? raw.error.slice(0, 4_000) : "",
    progress,
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 4_000) : progress.at(-1)?.summary ?? "",
    evidence: typeof raw.evidence === "string" ? raw.evidence.slice(0, 4_000) : progress.at(-1)?.evidence ?? "",
    blockedReason: typeof raw.blockedReason === "string" ? raw.blockedReason.slice(0, 4_000) : "",
    rejectedClaims: Math.max(0, Math.trunc(Number(raw.rejectedClaims) || 0)),
    unreadableStreak: Math.max(0, Math.trunc(Number(raw.unreadableStreak) || 0)),
    pendingTurnRecovery: raw.pendingTurnRecovery === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

function recoverLoopFromTemp(file: string, cwd: string, id: string): GoalLoop | null {
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
      try {
        const loop = hydrateLoop(JSON.parse(fs.readFileSync(temp.full, "utf8")), cwd, id);
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
    return hydrateLoop(JSON.parse(fs.readFileSync(file, "utf8")), cwd, id);
  } catch {
    return recoverLoopFromTemp(file, cwd, id);
  }
}

function writeLoop(loop: GoalLoop): boolean {
  if (writeLoopFailForTests) return false;
  try {
    loop.updatedAt = isoNow();
    const file = goalStateFile(loop.cwd, loop.id);
    const content = JSON.stringify(loop, null, 2);
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
    runtime.pi.appendEntry(ENTRY_TYPE, { snapshot: loop, at: Date.now() });
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
    blocked: "ブロック",
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
  for (let index = promptIndex + 1; index < entries.length; index += 1) {
    const entry = asRecord(entries[index]);
    if (entry?.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role === "user") break;
    if (message?.role === "assistant") {
      const result = extractGoalResult(assistantText(message));
      if (result) return result;
    }
  }
  return null;
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

function jsonInstructions(statuses: string): string {
  return `\n\nThe very last thing you output this turn must be a single fenced JSON block:\n\n\`\`\`json\n{"status":"progress","summary":"what changed this turn","next":"the next step","evidence":"commands run, files touched, results"}\n\`\`\`\n\n- status must be exactly one of: ${statuses}.\n- summary is required. Put a blocked reason in blockedReason when status is blocked.\n- Write nothing after the closing fence.`;
}

export function buildGoalPrompt(loop: GoalLoop, turn: number): string {
  const max = loop.maxTurns;
  const turnBudget = max === 0
    ? `This is loop turn ${turn}. There is no automatic turn limit.`
    : `This is turn ${turn} of ${loop.forceFullRun ? "exactly" : "at most"} ${max}. ${turn - 1} loop turn(s) completed before this one.`;
  const common = `${PROMPT_MARKER}\n\n${turnBudget} The next prompt is sent automatically after this turn ends.\n\nRules:\n- One turn = one iteration. Do the smallest useful increment, then end this turn. Do not simulate future work.\n- Report only work actually performed in this turn.\n- Keep changes incremental and reviewable.\n- Do not ask questions unless truly blocked.\n\nGoal:\n${loop.goal}${acceptanceText(loop)}${recentProgress(loop, 5)}`;
  if (loop.forceFullRun) {
    return `${common}\n\nYou are running in LeafCode full-run mode. Never declare the goal complete. The host will ${max === 0 ? "continue until you pause or stop it" : `run exactly ${max} goal turns`}. A completion claim is treated as progress.${jsonInstructions("progress, blocked")}`;
  }
  return `${common}\n\nContinue autonomously until the goal is completed, blocked, paused, or stopped. Do not claim completion without concrete evidence; a completion claim is independently verified.${jsonInstructions("progress, completed, blocked")}`;
}

export function buildGoalContinuationPrompt(loop: GoalLoop, turn: number): string {
  const turnBudget = loop.maxTurns === 0
    ? `This is loop turn ${turn}. There is no automatic turn limit.`
    : `This is turn ${turn} of ${loop.forceFullRun ? "exactly" : "at most"} ${loop.maxTurns}.`;
  const missingResultReminder = loop.unreadableStreak > 0
    ? "\n\nYour previous reply did not include the required JSON result block, so the loop could not read a result. This turn MUST end with the fenced JSON block described below, and nothing may come after it."
    : "";
  const common = `${PROMPT_MARKER}\n\nContinue the persistent goal loop. Work on exactly one smallest useful step, then end this turn. ${turnBudget}${missingResultReminder}\n\nGoal:\n${loop.goal}${acceptanceText(loop)}${recentProgress(loop, 2)}`;
  if (loop.forceFullRun) {
    return `${common}\n\nFull-run mode: never declare completion. The loop will ${loop.maxTurns === 0 ? "continue until you pause or stop it" : "run until the turn limit"}. Do not simulate future work.${jsonInstructions("progress, blocked")}`;
  }
  return `${common}\n\nDo not claim completion without concrete evidence.${jsonInstructions("progress, completed, blocked")}`;
}

export function buildVerificationPrompt(loop: GoalLoop): string {
  const claim = [...loop.progress].reverse().find((item) => item.status === "completed") ?? loop.progress.at(-1);
  return `${PROMPT_MARKER}\n\nThe previous turn claimed the goal was completed. Independently verify that claim. Inspect the repository and run appropriate checks; do not trust the claim's narration.\n\nGoal:\n${loop.goal}${acceptanceText(loop, "Acceptance criteria to verify")}\n\nClaimed completion:\n${claim ? `summary: ${claim.summary}\nevidence: ${claim.evidence ?? "(none)"}` : "(none)"}\n\nReturn verified_completed only when every criterion is backed by observable evidence. Return progress when more work is required, or blocked when verification cannot proceed.${jsonInstructions("verified_completed, progress, blocked")}`;
}

export function applyResult(loop: GoalLoop, result: GoalLoopProgress | null): void {
  if (!result) {
    // Keep the same free-retry / streak semantics as a missing assistant body.
    applyMissingResult(loop, "");
    return;
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
  loop.turnKind = loop.status === "verifying_completed" ? "verification" : "goal";
  writeLoop(loop);
}

/**
 * The model finished a run without the required JSON result block (e.g. it only
 * updated todos). Pause only after repeated misses: keep the loop alive once by
 * recording the assistant text as a plain progress entry and demanding the JSON
 * block in the next prompt.
 */
export function applyMissingResult(loop: GoalLoop, assistantText: string): void {
  const verification = loop.status === "running" && loop.turnKind === "verification";
  const summary = short(assistantText, 500) || "(結果JSONなし)";
  loop.progress = [...loop.progress, { time: isoNow(), status: "progress", summary }].slice(-MAX_PROGRESS);
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
  writeLoop(loop);
}

function clearPendingAgentRun(runtime: Runtime): void {
  runtime.pendingAgentMessages = undefined;
  runtime.pendingAgentAborted = false;
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
  applyResult(loop, result);
  const updated = currentLoop(runtime);
  // Failed persist leaves disk paused+pendingTurnRecovery. Keep runtime armed so
  // a later settle/resume does not apply the same JSON a second time blindly
  // after a partial in-memory apply, and so recovery can retry the write.
  if (!updated || updated.pendingTurnRecovery) {
    runtime.pausedTurnPending = true;
    return false;
  }
  updateUI(runtime, updated);
  appendSnapshot(runtime, updated);
  if (
    (pauseReason === "user" || pauseReason === "manual_send") &&
    !TERMINAL.has(updated.status) &&
    updated.status !== "paused"
  ) {
    updated.status = "paused";
    updated.pauseReason = pauseReason;
    updated.error = pauseError;
    updated.pendingTurnRecovery = false;
    updated.nextTurnAt = null;
    writeLoop(updated);
    updateUI(runtime, updated);
    appendSnapshot(runtime, updated);
  } else if (updated.status === "queued" || updated.status === "verifying_completed") {
    schedule(runtime);
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
    pauseLoop(runtime, "user", "実行が中断されたため一時停止しました。");
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
  if (result) applyResult(loop, result);
  else {
    const text = [...messages]
      .reverse()
      .map((message) => assistantText(message))
      .find((value) => value.trim()) ?? "";
    applyMissingResult(loop, text);
  }
  const updated = currentLoop(runtime);
  if (!updated || updated.status === "running") {
    // writeLoop failed; keep awaitingTurn/pending so timeout or resume can recover.
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
}

function pauseLoop(runtime: Runtime, reason: GoalLoopPauseReason = "user", error = "ユーザーが一時停止しました。"): void {
  const loop = currentLoop(runtime);
  if (!loop || TERMINAL.has(loop.status)) return;
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
  if (!writeLoop(loop)) return;
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
}

function stopLoop(runtime: Runtime): void {
  const loop = currentLoop(runtime);
  if (!loop || TERMINAL.has(loop.status)) return;
  // Capture before clearing: abort can make isIdle() true immediately, so a
  // replacement startLoop may send the next turn before trailing agent_end.
  const hadInflightAgent =
    runtime.awaitingTurn || runtime.pausedTurnPending || !runtime.ctx.isIdle();
  loop.status = "stopped";
  loop.pauseReason = "";
  loop.error = "";
  loop.pendingTurnRecovery = false;
  loop.nextTurnAt = null;
  if (!writeLoop(loop)) return;
  clearTimer(runtime);
  runtime.awaitingTurn = false;
  runtime.pausedTurnPending = false;
  runtime.awaitingTurnIndex = undefined;
  runtime.pausedTurnIndex = undefined;
  clearPendingAgentRun(runtime);
  if (hadInflightAgent) runtime.discardAgentSettlements += 1;
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  try {
    if (!runtime.ctx.isIdle()) runtime.ctx.abort();
  } catch {
    // The engine may already be settled.
  }
}

function completeLoop(runtime: Runtime): boolean {
  const loop = currentLoop(runtime);
  if (!loop || loop.status !== "paused" || loop.pauseReason !== "turn_limit") return false;
  // Refuse forged/stale turn_limit pauses that have not actually exhausted the budget.
  if (loop.maxTurns <= 0 || loop.turnCount < loop.maxTurns) return false;
  loop.status = "completed";
  loop.pauseReason = "";
  loop.error = "";
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
    if (!loop || TERMINAL.has(loop.status) || loop.status === "paused") return;
    if ((loop.status === "queued" || loop.status === "verifying_completed") && loop.nextTurnAt) {
      const nextTurnAt = Date.parse(loop.nextTurnAt);
      if (Number.isFinite(nextTurnAt) && Date.now() < nextTurnAt) {
        schedule(runtime, Math.max(250, nextTurnAt - Date.now()));
        return;
      }
    }
    if (!runtime.ctx.isIdle() || runtime.ctx.hasPendingMessages()) {
      schedule(runtime, 500);
      return;
    }
    // sendTurn内のthrowはvoid化されると未処理rejectでWebUIサーバごと落ちる。
    // 回復可能な形（一時停止→再開）に倒しておく。
    sendTurn(runtime).catch((error) => {
      console.error("[goal-loop] sendTurn failed:", error);
      if (!isActiveRuntime(runtime)) return;
      pauseLoop(
        runtime,
        "scheduler_error",
        `ターンの送信中にエラーが発生しました。${
          error instanceof Error ? ` ${error.message}` : ` ${String(error)}`
        }`,
      );
    });
  }, delay);
  runtime.timer.unref?.();
}

async function sendTurn(runtime: Runtime): Promise<void> {
  if (!isActiveRuntime(runtime) || runtime.awaitingTurn) return;
  const turnGeneration = runtime.turnGeneration;
  let loop = currentLoop(runtime);
  if (!loop || TERMINAL.has(loop.status) || loop.status === "paused") return;

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
    if (loop.status === "paused" || TERMINAL.has(loop.status)) return;
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
    if (!loop || TERMINAL.has(loop.status) || loop.status === "paused") return;
    if (!runtime.ctx.isIdle() || runtime.ctx.hasPendingMessages()) {
      schedule(runtime, 500);
      return;
    }
  }

  let prompt: string;
  let kind: GoalLoopTurnKind;
  let uiPrompt: string | undefined;
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
    const isInitialTurn = loop.turnCount === 1 && !retryingUnreadableResult;
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
  runtime.pendingAgentMessages = undefined;
  runtime.pendingAgentAborted = false;
  runtime.awaitingTurnIndex = undefined;
  runtime.pausedTurnIndex = undefined;
  runtime.timeoutTimer = setTimeout(() => {
    // After a dispose()-without-shutdown replacement, the new session may be
    // running again. A stale watchdog must not pause the shared loop state.
    if (!isActiveRuntime(runtime)) return;
    const current = currentLoop(runtime);
    if (runtime.awaitingTurn && current?.status === "running") {
      pauseLoop(runtime, "turn_timeout", "応答が確認できないまま時間切れになったため一時停止しました。");
    }
  }, turnTimeoutMs());
  runtime.timeoutTimer.unref?.();

  try {
    runtime.pi.sendMessage(
      {
        customType: kind === "verification" ? "leafcode-goal-verification" : "leafcode-goal-turn",
        content: prompt,
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
  } catch (error) {
    clearTimer(runtime);
    // sendMessage may throw after we already flipped to running/awaitingTurn.
    // Always leave a paused unknown_delivery state — never stay running with a
    // live awaitingTurn flag after a delivery exception.
    const current = currentLoop(runtime);
    if (current && !TERMINAL.has(current.status)) {
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
  },
): GoalLoop | null {
  const goal = config.goal.trim().slice(0, MAX_GOAL_CHARS);
  const acceptance = normalizeAcceptance(config.acceptance);
  if (!goal || !acceptance) return null;

  // A pending routing hook may resume after this replacement. Invalidate it
  // before stopping the old loop so it cannot send the old prompt into the new one.
  runtime.turnGeneration += 1;
  const previous = currentLoop(runtime);
  if (previous && !TERMINAL.has(previous.status)) stopLoop(runtime);
  clearTimer(runtime);
  // Terminal previous loops skip stopLoop; still drop any stuck awaiting flag so
  // a fresh start cannot hang on sendTurn's awaitingTurn gate.
  runtime.awaitingTurn = false;
  runtime.awaitingTurnIndex = undefined;
  runtime.pausedTurnPending = false;
  runtime.pausedTurnIndex = undefined;
  clearPendingAgentRun(runtime);

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
  // Do not schedule/notify as started when the durable write failed — disk still
  // holds the previous loop (or none), so sendTurn would race on stale state.
  if (!writeLoop(loop)) return null;
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
  const turns = text.match(/(?:^|\s)--(?:turns|max-turns)\s+(\d+)/i);
  if (turns) {
    maxTurns = clampMaxTurns(turns[1]);
    text = text.replace(turns[0], " ");
  }
  const cooldownFlag = text.match(/(?:^|\s)--cooldown\s+("[^"]*"|'[^']*'|\S+)/i);
  if (cooldownFlag) {
    const value = cooldownFlag[1].replace(/^("|')|(\1)$/g, "");
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
  const maxTurns = clampMaxTurns(maxTurnsText || DEFAULT_MAX_TURNS);
  const loop = startLoop(runtime, {
    goal,
    acceptance: acceptance ?? "",
    maxTurns,
    cooldownSeconds: parseCooldownSeconds(cooldownText),
    forceFullRun,
  });
  if (loop) runtime.ctx.ui.notify(`Goal loop started (${maxTurns}ターン${forceFullRun ? "・完走" : ""})`, "info");
}

function statusMessage(loop: GoalLoop | null): string {
  if (!loop) return "Goal loop はありません。/goal-compose で作成できます。";
  const turn = loop.status === "queued" ? loop.turnCount + 1 : loop.turnCount;
  const max = loop.maxTurns === 0 ? "∞" : String(loop.maxTurns);
  const shownTurn = loop.maxTurns === 0 ? turn : Math.min(turn, loop.maxTurns);
  const mode = loop.forceFullRun ? " · 完走モード" : "";
  const detail = loop.error ? ` · ${loop.error}` : "";
  return `${statusLabel(loop.status)} ${shownTurn}/${max}${mode} · ${short(loop.goal, 140)}${detail}`;
}

function resumeLoop(runtime: Runtime, maxTurns?: unknown): boolean {
  const loop = currentLoop(runtime);
  if (!loop || loop.status !== "paused") {
    runtime.ctx.ui.notify("一時停止中の Goal loop はありません。", "info");
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
      writeLoop(loop);
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
      applyResult(loop, recovered);
      const updated = currentLoop(runtime);
      // applyResult mutates memory then writeLoop. On failure disk still has
      // pendingTurnRecovery; treating this as success would let the next resume
      // apply the same transcript JSON again (double progress).
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
      }
      return true;
    }
    if (loop.pauseReason === "unknown_delivery") {
      // Keep pendingTurnRecovery so a later resume can still pick up a real
      // transcript result for THIS turnCount if delivery actually happened.
      runtime.ctx.ui.notify("送達が確認できないため再送しません。新しい Goal loop を開始してください。", "warning");
      writeLoop(loop);
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
  loop.pauseReason = "";
  loop.error = "";
  loop.pendingTurnRecovery = false;
  if (!preserveCooldown) loop.nextTurnAt = null;
  if (!writeLoop(loop)) {
    runtime.ctx.ui.notify("状態の保存に失敗したため再開できませんでした。", "error");
    return false;
  }
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  schedule(runtime, 0);
  return true;
}

function handleAction(runtime: Runtime, action: "pause" | "resume" | "stop" | "complete", args = ""): void {
  if (action === "pause") {
    const loop = currentLoop(runtime);
    if (!loop) runtime.ctx.ui.notify("Goal loop はありません。", "info");
    else {
      pauseLoop(runtime);
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
    stopLoop(runtime);
    runtime.ctx.ui.notify("Goal loop を停止しました。", "info");
    return;
  }
  if (action === "complete") {
    const completed = completeLoop(runtime);
    runtime.ctx.ui.notify(
      completed
        ? "Goal loop を完了しました。新しい Goal loop を開始できます。"
        : "最大ターン数に到達した一時停止中の Goal loop はありません。",
      completed ? "info" : "warning",
    );
    return;
  }
  const turns = args.match(/--(?:turns|max-turns)\s+(\d+)/i)?.[1];
  if (resumeLoop(runtime, turns)) runtime.ctx.ui.notify("Goal loop を再開しました。", "info");
}

function decodeStartConfig(args: string): {
  goal: string;
  acceptance?: unknown;
  maxTurns?: unknown;
  cooldownSeconds?: unknown;
  forceFullRun?: unknown;
  autoAgent?: unknown;
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
    };
  } catch {
    return null;
  }
}

function registerCommandAliases(pi: ExtensionAPI, getRuntime: () => Runtime | null): void {
  pi.registerCommand("goal-start", {
    description: "JSON/base64 形式で Goal loop を開始（Web Composer 用）",
    handler: async (args, ctx) => {
      const runtime = getRuntime();
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
      const runtime = getRuntime();
      if (!runtime) return;
      const config = parseStartArgs(args);
      const loop = startLoop(runtime, config);
      if (!loop) ctx.ui.notify("Goal loop を開始できませんでした（パラメータ不正または状態保存失敗）。", "error");
    },
  });
  pi.registerCommand("goal-status", {
    description: "Goal loop の状態を表示",
    handler: async (_args, ctx) => {
      const runtime = getRuntime();
      if (runtime) ctx.ui.notify(statusMessage(currentLoop(runtime)), "info");
    },
  });
  pi.registerCommand("goal-pause", {
    description: "Goal loop を一時停止",
    handler: async (args) => {
      const runtime = getRuntime();
      if (runtime) handleAction(runtime, "pause", args);
    },
  });
  pi.registerCommand("goal-resume", {
    description: "Goal loop を再開",
    handler: async (args) => {
      const runtime = getRuntime();
      if (runtime) handleAction(runtime, "resume", args);
    },
  });
  pi.registerCommand("goal-stop", {
    description: "Goal loop を停止",
    handler: async () => {
      const runtime = getRuntime();
      if (runtime) handleAction(runtime, "stop");
    },
  });
  pi.registerCommand("goal-complete", {
    description: "最大ターン数に到達した Goal loop を完了",
    handler: async () => {
      const runtime = getRuntime();
      if (runtime) handleAction(runtime, "complete");
    },
  });
  pi.registerCommand("goal-compose", {
    description: "Goal / 承認条件 / 最大ターン / 完走モードを設定する Composer",
    handler: async () => {
      const runtime = getRuntime();
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
    runtime = {
      key,
      cwd: ctx.cwd,
      sessionId: id,
      ctx,
      pi,
      awaitingTurn: false,
      turnGeneration: 0,
      pausedTurnPending: false,
      pausedTurnIndex: undefined,
      discardAgentSettlements: 0,
      disposed: false,
      pendingAgentAborted: false,
    };
    runtimes.set(key, runtime);

    const loop = currentLoop(runtime);
    if (loop?.status === "running") {
      // Only running has an in-flight prompt that needs manual recovery.
      // verifying_completed is an unsent verification turn, like queued; account
      // or agent routing can reopen the session before that turn is delivered.
      runtime.pausedTurnPending = true;
      loop.pendingTurnRecovery = true;
      loop.status = "paused";
      loop.pauseReason = "";
      loop.error = "セッション再開時は自動継続しません。/goal-resume で再開してください。";
      writeLoop(loop);
    }
    updateUI(runtime, loop);
    if (loop?.status === "queued" || loop?.status === "verifying_completed") {
      // The persisted absolute cooldown must survive extension/session reloads.
      schedule(runtime, 0);
    }
  });

  const getRuntime = (): Runtime | null => runtime && !runtime.disposed ? runtime : null;

  pi.on("input", async (event, ctx) => {
    const current = getRuntime();
    if (!current || event.source === "extension") return;
    if (/^\/(?:goal|goal-status|goal-pause|goal-resume|goal-stop|goal-complete|goal-compose)(?:\s|$)/i.test(event.text)) return;
    const loop = currentLoop(current);
    if (loop && (loop.status === "queued" || loop.status === "running" || loop.status === "verifying_completed")) {
      pauseLoop(current, "manual_send", "手動入力が行われたため一時停止しました。/goal-resume で再開できます。");
      try {
        if (!ctx.isIdle()) ctx.abort();
      } catch {
        // Already settled.
      }
    }
  });

  pi.on("turn_start", async (event, _ctx) => {
    const current = getRuntime();
    if (current?.awaitingTurn) current.awaitingTurnIndex = event.turnIndex;
  });

  pi.on("turn_end", async (event, _ctx) => {
    const current = getRuntime();
    if (!current) return;
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
    if (!current) return;
    // Trailing end from an aborted/replaced run — do not poison a newer await.
    if (current.discardAgentSettlements > 0) return;
    // After a mid-turn pause, awaitingTurn is false but we still need the final
    // messages so agent_settled can recover JSON (manual_send/abort races).
    if (!current.awaitingTurn && !current.pausedTurnPending) return;
    current.pendingAgentMessages = event.messages;
    current.pendingAgentAborted = event.messages.some(isAbortedAssistant) || Boolean(ctx.signal?.aborted);
  });

  pi.on("agent_settled", async (_event, _ctx) => {
    const current = getRuntime();
    if (!current) return;
    const loop = currentLoop(current);
    if (!loop) {
      clearPendingAgentRun(current);
      return;
    }
    if (TERMINAL.has(loop.status)) {
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
    if (current.awaitingTurn && loop.status === "running") {
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

  pi.on("session_shutdown", async (_event, _ctx) => {
    const current = getRuntime();
    if (!current) return;
    // dispose()/replace can leave this extension instance alive long enough to
    // see shutdown after a newer runtime already claimed the same key. Never
    // pause the shared loop or delete the replacement's map entry in that case.
    const active = isActiveRuntime(current);
    if (active) {
      const loop = currentLoop(current);
      if (loop && (loop.status === "running" || loop.status === "queued" || loop.status === "verifying_completed")) {
        // Persist mid-turn recovery across restart. pausedTurnPending alone dies
        // with this runtime, and the next session_start only sees status=paused.
        if (loop.status === "running") loop.pendingTurnRecovery = true;
        loop.status = "paused";
        loop.pauseReason = "";
        loop.error = "セッション終了時に一時停止しました。";
        writeLoop(loop);
        clearTimer(current);
        current.awaitingTurn = false;
      }
    }
    current.disposed = true;
    clearPendingAgentRun(current);
    clearTimer(current);
    if (active) runtimes.delete(current.key);
  });

  pi.registerCommand("goal", {
    description: "Goal loop を開始。/goal-compose で Composer を開く",
    handler: async (args, ctx) => {
      const current = getRuntime();
      if (!current) return;
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
  clampMaxTurns,
  clampCooldownSeconds,
  parseCooldownSeconds,
  setTurnTimeoutMs(ms?: number) {
    turnTimeoutMsForTests = typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  },
  setRenameSync(fn?: (temp: string, file: string) => void) {
    renameSyncForTests = fn;
  },
  setWriteLoopFail(fail?: boolean) {
    writeLoopFailForTests = fail === true;
  },
};
