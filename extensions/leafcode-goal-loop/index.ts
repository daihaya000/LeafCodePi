/**
 * LeafCode Goal Loop for Pi
 *
 * LeafCode の Goal Loop を Pi 拡張として実装したもの。
 * - 完走モード: 完了宣言を無視し、maxTurns まで必ず実行
 * - 通常モード: completed -> 検証ターン -> completed
 * - Pi native の agent_settled + sendMessage(followUp) で自動継続
 * - `.pi/goals-loop/<sessionId>.json` に状態を保存
 * - `/goal-compose` は Goal / acceptance / maxTurns / 完走モードを設定する Composer
 */

import * as fs from "node:fs";
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
  | "turn_limit"
  | "unreadable_result"
  | "turn_timeout"
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
  forceFullRun: boolean;
  turnCount: number;
  turnKind: GoalLoopTurnKind;
  pauseReason: GoalLoopPauseReason;
  error: string;
  progress: GoalLoopProgress[];
  summary: string;
  evidence: string;
  blockedReason: string;
  rejectedClaims: number;
  createdAt: string;
  updatedAt: string;
};

const GOALS_DIR = ".pi/goals-loop";
const PROMPT_MARKER = "<!-- webui-goal-loop-prompt -->";
const WIDGET_KEY = "leafcode-goal-loop";
const ENTRY_TYPE = "leafcode-goal-loop";
const DEFAULT_MAX_TURNS = 10;
const MAX_TURNS = 100;
const MAX_GOAL_CHARS = 4_000;
const MAX_ACCEPTANCE_ITEMS = 10;
const MAX_ACCEPTANCE_CHARS = 2_000;
const MAX_PROGRESS = 50;
const MAX_REJECTED_CLAIMS = 3;
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const TERMINAL = new Set<GoalLoopStatus>(["completed", "blocked", "stopped"]);

const runtimes = new Map<string, Runtime>();

type Runtime = {
  key: string;
  cwd: string;
  sessionId: string;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  awaitingTurn: boolean;
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

export function goalStateFile(cwd: string, id: string): string {
  return path.join(cwd, GOALS_DIR, `${safeIdPart(id)}.json`);
}

function isoNow(): string {
  return new Date().toISOString();
}

function clampMaxTurns(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(MAX_TURNS, Math.max(1, Math.trunc(number)))
    : DEFAULT_MAX_TURNS;
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
    value === "turn_limit" ||
    value === "unreadable_result" ||
    value === "turn_timeout" ||
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
    forceFullRun: raw.forceFullRun === true,
    turnCount: Math.max(0, Math.trunc(Number(raw.turnCount) || 0)),
    turnKind: normalizeTurnKind(raw.turnKind),
    pauseReason: normalizePauseReason(raw.pauseReason),
    error: typeof raw.error === "string" ? raw.error.slice(0, 4_000) : "",
    progress,
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 4_000) : progress.at(-1)?.summary ?? "",
    evidence: typeof raw.evidence === "string" ? raw.evidence.slice(0, 4_000) : progress.at(-1)?.evidence ?? "",
    blockedReason: typeof raw.blockedReason === "string" ? raw.blockedReason.slice(0, 4_000) : "",
    rejectedClaims: Math.max(0, Math.trunc(Number(raw.rejectedClaims) || 0)),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

function readLoop(cwd: string, id: string): GoalLoop | null {
  try {
    return hydrateLoop(JSON.parse(fs.readFileSync(goalStateFile(cwd, id), "utf8")), cwd, id);
  } catch {
    return null;
  }
}

function writeLoop(loop: GoalLoop): void {
  loop.updatedAt = isoNow();
  const file = goalStateFile(loop.cwd, loop.id);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(loop, null, 2), "utf8");
  fs.renameSync(temp, file);
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

function isActive(loop: GoalLoop | null): loop is GoalLoop {
  return Boolean(loop && !TERMINAL.has(loop.status));
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
    const badge = `${statusLabel(loop.status)} ${Math.min(turn, loop.maxTurns)}/${loop.maxTurns}`;
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
  const common = `${PROMPT_MARKER}\n\nThis is turn ${turn} of ${loop.forceFullRun ? "exactly" : "at most"} ${max}. ${turn - 1} loop turn(s) completed before this one. The next prompt is sent automatically after this turn ends.\n\nRules:\n- One turn = one iteration. Do the smallest useful increment, then end this turn. Do not simulate future work.\n- Report only work actually performed in this turn.\n- Keep changes incremental and reviewable.\n- Do not ask questions unless truly blocked.\n\nGoal:\n${loop.goal}${acceptanceText(loop)}${recentProgress(loop, 5)}`;
  if (loop.forceFullRun) {
    return `${common}\n\nYou are running in LeafCode full-run mode. Never declare the goal complete. The host will run exactly ${max} goal turns. A completion claim is treated as progress.${jsonInstructions("progress, blocked")}`;
  }
  return `${common}\n\nContinue autonomously until the goal is completed, blocked, paused, or stopped. Do not claim completion without concrete evidence; a completion claim is independently verified.${jsonInstructions("progress, completed, blocked")}`;
}

export function buildGoalContinuationPrompt(loop: GoalLoop, turn: number): string {
  const common = `${PROMPT_MARKER}\n\nContinue the persistent goal loop. Work on exactly one smallest useful step, then end this turn. This is turn ${turn} of ${loop.forceFullRun ? "exactly" : "at most"} ${loop.maxTurns}.\n\nGoal:\n${loop.goal}${acceptanceText(loop)}${recentProgress(loop, 2)}`;
  if (loop.forceFullRun) {
    return `${common}\n\nFull-run mode: never declare completion. Do not simulate future work.${jsonInstructions("progress, blocked")}`;
  }
  return `${common}\n\nDo not claim completion without concrete evidence.${jsonInstructions("progress, completed, blocked")}`;
}

export function buildVerificationPrompt(loop: GoalLoop): string {
  const claim = loop.progress.at(-1);
  return `${PROMPT_MARKER}\n\nThe previous turn claimed the goal was completed. Independently verify that claim. Inspect the repository and run appropriate checks; do not trust the claim's narration.\n\nGoal:\n${loop.goal}${acceptanceText(loop, "Acceptance criteria to verify")}\n\nClaimed completion:\n${claim ? `summary: ${claim.summary}\nevidence: ${claim.evidence ?? "(none)"}` : "(none)"}\n\nReturn verified_completed only when every criterion is backed by observable evidence. Return progress when more work is required, or blocked when verification cannot proceed.${jsonInstructions("verified_completed, progress, blocked")}`;
}

export function applyResult(loop: GoalLoop, result: GoalLoopProgress | null): void {
  if (!result) {
    loop.status = "paused";
    loop.pauseReason = "unreadable_result";
    loop.error = "ループの結果JSONを読めなかったため一時停止しました。";
    writeLoop(loop);
    return;
  }

  const verification = loop.status === "running" && loop.turnKind === "verification";
  const effective = loop.forceFullRun && !verification && result.status === "completed"
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
    loop.turnCount >= loop.maxTurns
  ) {
    loop.status = "paused";
    loop.pauseReason = "turn_limit";
    loop.error = "最大ターン数に到達したため一時停止しました。";
  } else if (loop.status !== "paused") {
    loop.pauseReason = "";
    loop.error = "";
  }
  loop.turnKind = loop.status === "verifying_completed" ? "verification" : "goal";
  writeLoop(loop);
}

function pauseLoop(runtime: Runtime, reason: GoalLoopPauseReason = "user", error = "ユーザーが一時停止しました。"): void {
  const loop = currentLoop(runtime);
  if (!loop || TERMINAL.has(loop.status)) return;
  clearTimer(runtime);
  runtime.awaitingTurn = false;
  loop.status = "paused";
  loop.pauseReason = reason;
  loop.error = error;
  writeLoop(loop);
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
}

function stopLoop(runtime: Runtime): void {
  const loop = currentLoop(runtime);
  if (!loop || TERMINAL.has(loop.status)) return;
  clearTimer(runtime);
  runtime.awaitingTurn = false;
  loop.status = "stopped";
  loop.pauseReason = "";
  loop.error = "";
  writeLoop(loop);
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  try {
    if (!runtime.ctx.isIdle()) runtime.ctx.abort();
  } catch {
    // The engine may already be settled.
  }
}

function schedule(runtime: Runtime, delay = 250): void {
  if (runtime.disposed || runtime.timer) return;
  runtime.timer = setTimeout(() => {
    runtime.timer = undefined;
    if (runtime.disposed) return;
    const loop = currentLoop(runtime);
    if (!loop || TERMINAL.has(loop.status) || loop.status === "paused") return;
    if (!runtime.ctx.isIdle() || runtime.ctx.hasPendingMessages()) {
      schedule(runtime, 500);
      return;
    }
    sendTurn(runtime);
  }, delay);
  runtime.timer.unref?.();
}

function sendTurn(runtime: Runtime): void {
  if (runtime.disposed || runtime.awaitingTurn) return;
  const loop = currentLoop(runtime);
  if (!loop || TERMINAL.has(loop.status) || loop.status === "paused") return;

  let prompt: string;
  let kind: GoalLoopTurnKind;
  if (loop.status === "queued") {
    if (loop.turnCount >= loop.maxTurns) {
      loop.status = "paused";
      loop.pauseReason = "turn_limit";
      loop.error = "最大ターン数に到達したため一時停止しました。";
      writeLoop(loop);
      updateUI(runtime, loop);
      return;
    }
    loop.turnCount += 1;
    loop.status = "running";
    loop.turnKind = "goal";
    kind = "goal";
    prompt = loop.turnCount === 1
      ? buildGoalPrompt(loop, loop.turnCount)
      : buildGoalContinuationPrompt(loop, loop.turnCount);
  } else if (loop.status === "verifying_completed") {
    loop.status = "running";
    loop.turnKind = "verification";
    kind = "verification";
    prompt = buildVerificationPrompt(loop);
  } else {
    return;
  }

  writeLoop(loop);
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  runtime.awaitingTurn = true;
  runtime.timeoutTimer = setTimeout(() => {
    const current = currentLoop(runtime);
    if (runtime.awaitingTurn && current?.status === "running") {
      pauseLoop(runtime, "turn_timeout", "応答が確認できないまま時間切れになったため一時停止しました。");
    }
  }, TURN_TIMEOUT_MS);
  runtime.timeoutTimer.unref?.();

  try {
    runtime.pi.sendMessage(
      {
        customType: kind === "verification" ? "leafcode-goal-verification" : "leafcode-goal-turn",
        content: prompt,
        display: false,
        details: { goalId: loop.id, turn: loop.turnCount, kind, forceFullRun: loop.forceFullRun },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  } catch (error) {
    clearTimer(runtime);
    runtime.awaitingTurn = false;
    const current = currentLoop(runtime);
    if (current) {
      current.status = "queued";
      if (kind === "goal") current.turnCount = Math.max(0, current.turnCount - 1);
      current.pauseReason = "scheduler_error";
      current.error = error instanceof Error ? error.message : String(error);
      writeLoop(current);
      updateUI(runtime, current);
    }
  }
}

function startLoop(
  runtime: Runtime,
  config: { goal: string; acceptance?: unknown; maxTurns?: unknown; forceFullRun?: unknown },
): GoalLoop | null {
  const goal = config.goal.trim().slice(0, MAX_GOAL_CHARS);
  const acceptance = normalizeAcceptance(config.acceptance);
  if (!goal || !acceptance) return null;

  const previous = currentLoop(runtime);
  if (previous && !TERMINAL.has(previous.status)) stopLoop(runtime);
  clearTimer(runtime);

  const now = isoNow();
  const loop: GoalLoop = {
    id: runtime.sessionId,
    sessionId: runtime.sessionId,
    cwd: runtime.cwd,
    status: "queued",
    goal,
    acceptance,
    maxTurns: clampMaxTurns(config.maxTurns),
    forceFullRun: config.forceFullRun === true,
    turnCount: 0,
    turnKind: "goal",
    pauseReason: "",
    error: "",
    progress: [],
    summary: "",
    evidence: "",
    blockedReason: "",
    rejectedClaims: 0,
    createdAt: now,
    updatedAt: now,
  };
  writeLoop(loop);
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  schedule(runtime, 0);
  return loop;
}

function parseStartArgs(args: string): { goal: string; maxTurns: number; forceFullRun: boolean; acceptance: string[] } {
  let text = args.trim();
  let forceFullRun = false;
  let maxTurns = DEFAULT_MAX_TURNS;
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
  const acceptanceFlag = text.match(/(?:^|\s)--acceptance(?:=|\s+)("[^"]*"|'[^']*'|\S+)/i);
  if (acceptanceFlag) {
    const value = acceptanceFlag[1].replace(/^("|')|("|')$/g, "");
    acceptance = normalizeAcceptance(value.replace(/\\n/g, "\n")) ?? [];
    text = text.replace(acceptanceFlag[0], " ");
  }
  return { goal: text.replace(/\s+/g, " ").trim(), maxTurns, forceFullRun, acceptance };
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
  const forceFullRun = await runtime.ctx.ui.confirm(
    "完走モード",
    "完了宣言を使わず、指定した最大ターン数まで必ず実行します。",
  );
  const maxTurns = clampMaxTurns(maxTurnsText || DEFAULT_MAX_TURNS);
  const loop = startLoop(runtime, {
    goal,
    acceptance: acceptance ?? "",
    maxTurns,
    forceFullRun,
  });
  if (loop) runtime.ctx.ui.notify(`Goal loop started (${maxTurns}ターン${forceFullRun ? "・完走" : ""})`, "info");
}

function statusMessage(loop: GoalLoop | null): string {
  if (!loop) return "Goal loop はありません。/goal-compose で作成できます。";
  const turn = loop.status === "queued" ? loop.turnCount + 1 : loop.turnCount;
  const mode = loop.forceFullRun ? " · 完走モード" : "";
  const detail = loop.error ? ` · ${loop.error}` : "";
  return `${statusLabel(loop.status)} ${Math.min(turn, loop.maxTurns)}/${loop.maxTurns}${mode} · ${short(loop.goal, 140)}${detail}`;
}

function resumeLoop(runtime: Runtime, maxTurns?: unknown): boolean {
  const loop = currentLoop(runtime);
  if (!loop || loop.status !== "paused") {
    runtime.ctx.ui.notify("一時停止中の Goal loop はありません。", "info");
    return false;
  }
  if (maxTurns !== undefined) loop.maxTurns = Math.max(loop.maxTurns, clampMaxTurns(maxTurns));
  if (loop.turnCount >= loop.maxTurns) {
    runtime.ctx.ui.notify("最大ターン数を増やしてから再開してください。例: /goal-resume --turns 20", "warning");
    writeLoop(loop);
    return false;
  }
  loop.status = loop.turnKind === "verification" ? "verifying_completed" : "queued";
  loop.pauseReason = "";
  loop.error = "";
  writeLoop(loop);
  updateUI(runtime, loop);
  appendSnapshot(runtime, loop);
  schedule(runtime, 0);
  return true;
}

function handleAction(runtime: Runtime, action: "pause" | "resume" | "stop", args = ""): void {
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
  const turns = args.match(/--(?:turns|max-turns)\s+(\d+)/i)?.[1];
  if (resumeLoop(runtime, turns)) runtime.ctx.ui.notify("Goal loop を再開しました。", "info");
}

function decodeStartConfig(args: string): {
  goal: string;
  acceptance?: unknown;
  maxTurns?: unknown;
  forceFullRun?: unknown;
} | null {
  try {
    const decoded = Buffer.from(args.trim(), "base64url").toString("utf8");
    const raw = asRecord(JSON.parse(decoded));
    if (!raw || typeof raw.goal !== "string") return null;
    return {
      goal: raw.goal,
      acceptance: raw.acceptance,
      maxTurns: raw.maxTurns,
      forceFullRun: raw.forceFullRun,
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
        ctx.ui.notify("Goal または承認条件が不正です。", "error");
        return;
      }
      ctx.ui.notify(`Goal loop started: ${loop.maxTurns}ターン${loop.forceFullRun ? "・完走" : ""}`, "info");
    },
  });
  pi.registerCommand("goal-set", {
    description: "Goal loop を引数で開始",
    handler: async (args, ctx) => {
      const runtime = getRuntime();
      if (!runtime) return;
      const config = parseStartArgs(args);
      const loop = startLoop(runtime, config);
      if (!loop) ctx.ui.notify("Goal または承認条件が不正です。", "error");
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
      disposed: false,
    };
    runtimes.set(key, runtime);

    const loop = currentLoop(runtime);
    if (loop?.status === "running" || loop?.status === "verifying_completed") {
      loop.status = "paused";
      loop.pauseReason = "user";
      loop.error = "セッション再開時は自動継続しません。/goal-resume で再開してください。";
      writeLoop(loop);
    }
    updateUI(runtime, loop);
  });

  const getRuntime = (): Runtime | null => runtime && !runtime.disposed ? runtime : null;

  pi.on("input", async (event, ctx) => {
    const current = getRuntime();
    if (!current || event.source === "extension") return;
    if (/^\/(?:goal|goal-status|goal-pause|goal-resume|goal-stop|goal-compose)(?:\s|$)/i.test(event.text)) return;
    const loop = currentLoop(current);
    if (isActive(loop)) {
      pauseLoop(current, "user", "手動入力を検出したため一時停止しました。/goal-resume で再開できます。");
      try {
        if (!ctx.isIdle()) ctx.abort();
      } catch {
        // Already settled.
      }
    }
  });

  pi.on("turn_end", async (event, _ctx) => {
    const current = getRuntime();
    if (!current || !current.awaitingTurn) return;
    const loop = currentLoop(current);
    if (!loop || loop.status !== "running") return;

    current.awaitingTurn = false;
    if (current.timeoutTimer) clearTimeout(current.timeoutTimer);
    current.timeoutTimer = undefined;
    const result = extractGoalResult(assistantText(event.message));
    applyResult(loop, result);
    const updated = currentLoop(current);
    updateUI(current, updated);
    if (updated) appendSnapshot(current, updated);
  });

  pi.on("agent_end", async (event, ctx) => {
    const current = getRuntime();
    if (!current || !current.awaitingTurn) return;
    if (event.messages.some(isAbortedAssistant) || ctx.signal?.aborted) {
      pauseLoop(current, "user", "実行が中断されたため一時停止しました。/goal-resume で再開できます。");
    }
    // 非 retryable error は agent_settled で結果なしとして停止する。
  });

  pi.on("agent_settled", async (_event, _ctx) => {
    const current = getRuntime();
    if (!current) return;
    const loop = currentLoop(current);
    if (!loop) return;
    if (current.awaitingTurn && loop.status === "running") {
      pauseLoop(current, "unreadable_result", "応答から結果JSONを読み取れなかったため一時停止しました。");
      return;
    }
    if (loop.status === "queued" || loop.status === "verifying_completed") schedule(current);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    const current = getRuntime();
    if (!current) return;
    const loop = currentLoop(current);
    if (loop && (loop.status === "running" || loop.status === "queued" || loop.status === "verifying_completed")) {
      clearTimer(current);
      current.awaitingTurn = false;
      loop.status = "paused";
      loop.pauseReason = "user";
      loop.error = "セッション終了時に一時停止しました。";
      writeLoop(loop);
    }
    current.disposed = true;
    clearTimer(current);
    runtimes.delete(current.key);
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
      if (command === "pause" || command === "resume" || command === "stop") {
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
        ctx.ui.notify("Goal または承認条件が不正です。", "error");
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
  buildGoalPrompt,
  buildGoalContinuationPrompt,
  buildVerificationPrompt,
  applyResult,
  goalStateFile,
};
