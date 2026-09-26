/**
 * Pi セッション向けハング watchdog（本家 LeafCode の hang-watchdog.ts 相当）。
 * OpenCode API の代わりに harness の LiveRuntime を直接監視する。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  shouldAttachResumeImages,
  turnHasActiveTool,
  turnHasAssistantResponse,
} from "@/lib/aborted-resume";
import { markHangRetryPrompt } from "@/lib/hang-retry";
import { autoResumePrompt } from "@/lib/hang-timeout";
import { dataDir } from "@/lib/paths";
import {
  readAutoResumeModeSetting,
  readHangTimeoutSettingMs,
} from "@/lib/pi/hang-settings";
import type { PromptImage } from "@/lib/pi/harness";
import { hasActiveTaskLease, ownsTaskLease } from "@/lib/task-runtime-lease";
import type { PromptFileInput } from "@/lib/prompt-images";
import type { UiMessage } from "@/lib/types";

export const HANG_WATCHDOG_INTERVAL_MS = 15_000;
export const MAX_WATCH_BODY_BYTES = 2_000_000;
export const HANG_CONFIRM_GRACE_MS = 30_000;
export const SILENT_RESPONSE_GRACE_MS = 30_000;
export const MISSING_LIVE_GRACE_MS = 30_000;
/** Parent hang skip while only a subagent/task tool is active — unbounded skip left stuck children forever. */
export const SUBAGENT_ACTIVE_GRACE_MS = 10 * 60_000;
/** Auto-resume after hang abort stops once this many retries have been used. */
export const MAX_HANG_RETRIES = 3;

export type TaskHangWatchRow = {
  taskId: string;
  prompt: string;
  images: PromptImage[];
  files: PromptFileInput[];
  agent?: string;
  subagentPermission?: "allow" | "deny";
  permissionMode?: "allow" | "ask" | "deny";
  /** Keep provider-limit recovery prompts hidden across watchdog retries. */
  isProviderFallback?: boolean;
  /** Keep WebSocket recovery prompts hidden across watchdog retries. */
  isTransportRecovery?: boolean;
  /**
   * Goal Loop arms hang watches for abort-on-hang, but must not resume via
   * queuePrompt (that would inject routing text as a normal chat turn).
   */
  skipResume?: boolean;
  resumeAllowed: boolean;
  startedAt: number;
  lastProgressAt: number;
  progressFingerprint: string;
  retryUsed: number;
  state: "armed" | "resolving";
  updatedAt: number;
  missingLiveSince?: number;
};

export type ArmTaskHangWatchInput = {
  taskId: string;
  prompt: string;
  images?: PromptImage[];
  files?: PromptFileInput[];
  agent?: string;
  subagentPermission?: "allow" | "deny";
  permissionMode?: "allow" | "ask" | "deny";
  startedAt?: number;
  isHangRetry?: boolean;
  isProviderFallback?: boolean;
  isTransportRecovery?: boolean;
  /** When true, hang abort does not call resumePrompt (Goal Loop turns). */
  skipResume?: boolean;
};

export type HangWatchdogHooks = {
  getLive: (taskId: string) => {
    isStreaming: boolean;
    isCompacting: boolean;
    messages: UiMessage[];
    /** True while WebUI permission/question dialogs are waiting on the user. */
    hasPendingAttention?: boolean;
  } | null;
  abortTask: (taskId: string) => Promise<void>;
  resumePrompt: (
    taskId: string,
    input: {
      prompt: string;
      images?: PromptImage[];
      files?: PromptFileInput[];
      agent?: string;
      subagentPermission?: "allow" | "deny";
      permissionMode?: "allow" | "ask" | "deny";
      isProviderFallback?: boolean;
      isTransportRecovery?: boolean;
    },
  ) => void;
  notifyHangRetry: (taskId: string, retryCount: number) => void;
  /** Called when a restart left a watched task without a live session. */
  onMissingLive?: (taskId: string, reason: string) => void;
};

type WatchStore = {
  version: 1;
  watches: TaskHangWatchRow[];
};

let hooks: HangWatchdogHooks | null = null;
const memoryWatches = new Map<string, TaskHangWatchRow>();
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogStarted = false;
let watchdogTicking = false;
const idleWaitAttempts = 6;
const idleWaitIntervalMs = 1_000;

function watchesPath(): string {
  return join(dataDir(), "hang-watches.json");
}

function readStoreFile(file: string): WatchStore | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as WatchStore;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.watches)) return null;
    const watches = parsed.watches.filter((row): row is TaskHangWatchRow =>
        row && typeof row.taskId === "string" && row.taskId.trim().length > 0 &&
        typeof row.prompt === "string" && Array.isArray(row.images) &&
        typeof row.resumeAllowed === "boolean" &&
        Number.isFinite(row.startedAt) && Number.isFinite(row.lastProgressAt) &&
        Number.isInteger(row.retryUsed) && row.retryUsed >= 0 &&
        typeof row.progressFingerprint === "string" &&
        (row.state === "armed" || row.state === "resolving"),
    );
    // An incomplete temp snapshot must not replace a valid main snapshot.
    if (parsed.watches.length > 0 && watches.length === 0) return null;
    return { version: 1, watches };
  } catch {
    return null;
  }
}

function readStore(): WatchStore {
  return readStoreFile(watchesPath()) ?? { version: 1, watches: [] };
}

function writeStore(): void {
  const file = watchesPath();
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temp,
      `${JSON.stringify({ version: 1, watches: [...memoryWatches.values()] }, null, 2)}\n`,
      "utf8",
    );
    // Never truncate the only recoverable snapshot if the process stops mid-write.
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* temp may not exist */ }
    throw error;
  }
}

function logWatchdog(message: string, row: Pick<TaskHangWatchRow, "taskId">, error?: unknown): void {
  const detail = error instanceof Error ? ` (${error.message})` : "";
  console.log(`[hang-watchdog] ${message}${detail}`, JSON.stringify({ taskId: row.taskId }));
}

export function registerHangWatchdogHooks(next: HangWatchdogHooks): void {
  hooks = next;
}

export function estimateWatchBodyBytes(input: {
  prompt: string;
  images?: PromptImage[];
  files?: PromptFileInput[];
}): number {
  let total = input.prompt.length;
  for (const image of input.images ?? []) {
    total += image.data.length + (image.mimeType?.length ?? 0);
  }
  for (const file of input.files ?? []) {
    total += file.data.length + file.name.length + file.mimeType.length;
  }
  return total;
}

export function progressFingerprint(messages: UiMessage[]): string {
  const contentKey = (text: string) => `${text.length}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
  return messages
    .map((message) => {
      const parts = message.parts
        .map((part) => {
          if (part.type === "text") return `t:${contentKey(part.text)}`;
          if (part.type === "thinking") return `k:${contentKey(part.text)}`;
          if (part.type === "tool") {
            // Include content as well as length: overwritten progress lines can
            // change without growing, and are not a hang.
            return `o:${part.state.status}:${contentKey(part.state.output ?? "")}`;
          }
          if (part.type === "image") return "i:1";
          if (part.type === "file") return `f:${part.name}`;
          return "?";
        })
        .join(",");
      return `${message.role}:${message.id}:${parts}`;
    })
    .join("|");
}

export function latestActivityAt(messages: UiMessage[], startedAt: number): number {
  let latest = startedAt;
  for (const message of messages) {
    if (message.createdAt > latest) latest = message.createdAt;
    for (const part of message.parts) {
      if (part.type === "tool") {
        if (part.state.startedAtMs && part.state.startedAtMs > latest) {
          latest = part.state.startedAtMs;
        }
        if (part.state.endedAtMs && part.state.endedAtMs > latest) {
          latest = part.state.endedAtMs;
        }
      }
    }
  }
  return latest;
}

/** 子エージェントの実行中は、親ターンのハング watchdog から除外する。 */
export function turnHasOnlyActiveSubagentTool(
  messages: UiMessage[],
  startedAtMs: number,
): boolean {
  let from = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user" && message.createdAt >= startedAtMs) {
      from = i + 1;
      break;
    }
  }

  let hasActiveTool = false;
  for (const message of messages.slice(from)) {
    for (const part of message.parts) {
      if (
        part.type !== "tool" ||
        (part.state.status !== "running" && part.state.status !== "pending")
      ) {
        continue;
      }
      hasActiveTool = true;
      const tool = part.tool.toLowerCase();
      if (!tool.includes("subagent") && tool !== "task") return false;
    }
  }
  return hasActiveTool;
}

function syncMemoryFromDisk(snapshot = readStore()): void {
  memoryWatches.clear();
  for (const row of snapshot.watches) {
    memoryWatches.set(row.taskId, {
      ...row,
      files: Array.isArray(row.files) ? row.files : [],
    });
  }
}

export function recoverInterruptedHangWatches(): void {
  const file = watchesPath();
  let snapshot = readStoreFile(file);
  let selectedTemp: string | null = null;
  let newest = 0;
  if (snapshot) {
    try { newest = statSync(file).mtimeMs; } catch { /* main snapshot disappeared */ }
  }
  try {
    for (const name of readdirSync(dirname(file))) {
      if (!name.startsWith(`${basename(file)}.`) || !/\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name)) continue;
      try {
        const temp = join(dirname(file), name);
        const mtime = statSync(temp).mtimeMs;
        if (mtime <= newest) continue;
        const candidate = readStoreFile(temp);
        if (candidate) {
          snapshot = candidate;
          selectedTemp = temp;
          newest = mtime;
        }
      } catch { /* this temp disappeared: inspect the remaining candidates */ }
    }
  } catch { /* missing directory: keep the main snapshot */ }
  syncMemoryFromDisk(snapshot ?? { version: 1, watches: [] });
  for (const row of memoryWatches.values()) {
    if (row.state === "resolving") {
      row.state = "armed";
      row.updatedAt = Date.now();
    }
  }
  writeStore();
  // Once the recovered snapshot is durably promoted, it must not win again
  // after later updates (a temp file may have a future mtime from clock skew).
  if (selectedTemp) {
    try { unlinkSync(selectedTemp); } catch { /* another process may have moved it */ }
  }
}

export function armTaskHangWatch(input: ArmTaskHangWatchInput): void {
  const taskId = input.taskId.trim();
  if (!taskId) return;
  if (!input.prompt.trim() && (input.images?.length ?? 0) === 0 && (input.files?.length ?? 0) === 0) return;

  const bodyBytes = estimateWatchBodyBytes({ prompt: input.prompt, images: input.images, files: input.files });
  const resumeAllowed = bodyBytes <= MAX_WATCH_BODY_BYTES;
  const startedAt = input.startedAt ?? Date.now();
  const preserveRetry = input.isHangRetry === true;
  const existing = memoryWatches.get(taskId);

  const row: TaskHangWatchRow = {
    taskId,
    prompt: input.prompt,
    images: input.images ?? [],
    files: input.files ?? [],
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.subagentPermission ? { subagentPermission: input.subagentPermission } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(input.isProviderFallback ? { isProviderFallback: true } : {}),
    ...(input.isTransportRecovery ? { isTransportRecovery: true } : {}),
    ...(input.skipResume ? { skipResume: true } : {}),
    resumeAllowed,
    startedAt,
    lastProgressAt: startedAt,
    progressFingerprint: "",
    retryUsed: preserveRetry && existing ? existing.retryUsed : 0,
    state: "armed",
    updatedAt: Date.now(),
  };
  memoryWatches.set(taskId, row);
  writeStore();
}

export function disarmTaskHangWatch(taskId: string): void {
  if (!memoryWatches.delete(taskId.trim())) return;
  writeStore();
}

export function getTaskHangWatch(taskId: string): TaskHangWatchRow | null {
  return memoryWatches.get(taskId.trim()) ?? null;
}

function isCurrentWatch(row: TaskHangWatchRow): boolean {
  return memoryWatches.get(row.taskId) === row;
}

function markResolving(row: TaskHangWatchRow): boolean {
  if (memoryWatches.get(row.taskId) !== row) return false;
  if (row.state === "resolving") return false;
  row.state = "resolving";
  row.updatedAt = Date.now();
  writeStore();
  return true;
}

function markArmed(taskId: string): void {
  const row = memoryWatches.get(taskId);
  if (!row) return;
  row.state = "armed";
  row.updatedAt = Date.now();
  writeStore();
}

function recordProgress(taskId: string, lastProgressAt: number, fingerprint: string): void {
  const row = memoryWatches.get(taskId);
  if (!row) return;
  row.lastProgressAt = lastProgressAt;
  row.progressFingerprint = fingerprint;
  row.updatedAt = Date.now();
  writeStore();
}

async function waitForIdle(taskId: string): Promise<boolean> {
  if (!hooks) return false;
  for (let attempt = 0; attempt < idleWaitAttempts; attempt += 1) {
    const live = hooks.getLive(taskId);
    if (live && !live.isStreaming && !live.isCompacting) return true;
    await new Promise((resolve) => setTimeout(resolve, idleWaitIntervalMs));
  }
  return false;
}

async function resolveHang(row: TaskHangWatchRow): Promise<void> {
  if (!hooks) return;
  if (!markResolving(row)) return;
  logWatchdog("hang detected — stopping the turn", row);

  try {
    await hooks.abortTask(row.taskId);
  } catch (error) {
    logWatchdog("abort failed", row, error);
  }

  if (!(await waitForIdle(row.taskId))) {
    if (isCurrentWatch(row)) {
      markArmed(row.taskId);
      logWatchdog("still busy after abort — will retry on a later tick", row);
    }
    return;
  }

  // A manual stop or a newer prompt can replace this watch while abort is
  // settling. Never revive a request that is no longer the current watch.
  if (!isCurrentWatch(row)) {
    logWatchdog("watch was cancelled while aborting — not resuming", row);
    return;
  }

  // Goal Loop hang: stop the turn, but never re-inject the routing prompt as chat.
  if (row.skipResume) {
    disarmTaskHangWatch(row.taskId);
    logWatchdog("stopped Goal Loop hang without chat resume", row);
    return;
  }

  if (row.retryUsed >= MAX_HANG_RETRIES) {
    disarmTaskHangWatch(row.taskId);
    logWatchdog(
      `stopped after ${row.retryUsed} hang retries without resuming`,
      row,
    );
    return;
  }

  const resumeMode = readAutoResumeModeSetting();
  const attachFiles =
    row.resumeAllowed &&
    shouldAttachResumeImages(resumeMode, row.prompt, row.images.length + row.files.length);
  if (!row.resumeAllowed && !(resumeMode === "continue" && row.prompt.trim())) {
    disarmTaskHangWatch(row.taskId);
    logWatchdog("stopped without resuming (request body was too large to store)", row);
    return;
  }

  const now = Date.now();
  row.retryUsed += 1;
  row.startedAt = now;
  row.lastProgressAt = now;
  row.progressFingerprint = "";
  row.state = "armed";
  row.updatedAt = now;
  writeStore();

  hooks.resumePrompt(row.taskId, {
    prompt: markHangRetryPrompt(autoResumePrompt(resumeMode, row.prompt)),
    images: attachFiles ? row.images : [],
    files: attachFiles ? row.files : [],
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.subagentPermission ? { subagentPermission: row.subagentPermission } : {}),
    ...(row.permissionMode ? { permissionMode: row.permissionMode } : {}),
    ...(row.isProviderFallback ? { isProviderFallback: true } : {}),
    ...(row.isTransportRecovery ? { isTransportRecovery: true } : {}),
  });
  hooks.notifyHangRetry(row.taskId, row.retryUsed);
  logWatchdog(`resumed the request with ${resumeMode} mode (retry #${row.retryUsed})`, row);
}

function isTurnComplete(messages: UiMessage[], startedAt: number): boolean {
  if (!turnHasAssistantResponse(messages, startedAt)) return false;
  return !turnHasActiveTool(messages, startedAt);
}

async function evaluateWatch(row: TaskHangWatchRow, timeoutMs: number): Promise<void> {
  if (!hooks) return;
  const live = hooks.getLive(row.taskId);
  if (!live) {
    // WebUI restart can temporarily detach the session. Give reattachment a
    // short grace period, then close the orphan explicitly instead of leaving
    // a working task and its watch around forever.
    const now = Date.now();
    if (row.missingLiveSince === undefined) {
      row.missingLiveSince = now;
      row.updatedAt = now;
      writeStore();
      logWatchdog("live session missing - waiting for reattachment", row);
      return;
    }
    if (now - row.missingLiveSince < MISSING_LIVE_GRACE_MS) return;
    // 別ワーカーが lease を持っているなら、こちらの getLive() が null なのは正常。
    // watch を外したり error に落とすと、実行中のタスクを誤停止する。
    // grace も消費しない（lease 消滅直後に即 onMissingLive しないよう振り直す）。
    if (hasActiveTaskLease(row.taskId) && !ownsTaskLease(row.taskId)) {
      if (row.missingLiveSince !== undefined) {
        delete row.missingLiveSince;
        row.updatedAt = now;
        writeStore();
      }
      logWatchdog("live session missing - another worker holds the lease", row);
      return;
    }
    disarmTaskHangWatch(row.taskId);
    hooks.onMissingLive?.(
      row.taskId,
      "The live session disappeared during a WebUI restart; the task was stopped.",
    );
    logWatchdog("live session missing - stopped the orphaned task", row);
    return;
  }
  if (row.missingLiveSince !== undefined) {
    delete row.missingLiveSince;
    row.updatedAt = Date.now();
    writeStore();
  }

  const { messages, isStreaming, isCompacting, hasPendingAttention } = live;
  // Compaction temporarily makes the session idle-looking while the previous
  // turn is being rewritten. Never abort or resume against that intermediate
  // transcript; the next tick will evaluate the compacted branch.
  if (isCompacting) return;
  if (turnHasOnlyActiveSubagentTool(messages, row.startedAt)) {
    // Child sessions have no hang watch. Skip parent abort while the subagent
    // is active, but bound the skip so a stuck child cannot hang forever.
    const now = Date.now();
    const graceMs = Math.max(timeoutMs * 3, SUBAGENT_ACTIVE_GRACE_MS);
    const activityAt = Math.max(latestActivityAt(messages, row.startedAt), row.lastProgressAt);
    if (now - activityAt < graceMs) return;
    await resolveHang(row);
    return;
  }
  // Permission/question UI waits on the user — that is not a hung model turn.
  // Keep the hang clock fresh so answering does not immediately trip abort.
  if (hasPendingAttention) {
    recordProgress(row.taskId, Date.now(), progressFingerprint(messages));
    return;
  }

  const fingerprint = progressFingerprint(messages);
  const activityAt = Math.max(latestActivityAt(messages, row.startedAt), row.startedAt);

  if (!isStreaming && !isCompacting) {
    if (!turnHasActiveTool(messages, row.startedAt) && isTurnComplete(messages, row.startedAt)) {
      disarmTaskHangWatch(row.taskId);
      return;
    }
  }

  const now = Date.now();
  if (now - row.lastProgressAt < timeoutMs) return;

  const activeTool = turnHasActiveTool(messages, row.startedAt);
  const assistantResponse = turnHasAssistantResponse(messages, row.startedAt);
  const fingerprintChanged =
    row.progressFingerprint !== "" && row.progressFingerprint !== fingerprint;

  if (fingerprintChanged || activityAt > row.lastProgressAt) {
    // Anchor the clock to the real event time whenever there is one (tool
    // start/end, new message). Sampling only runs once the row already looks
    // stale, so trusting this tick's clock would push the abort up to one
    // extra timeout past the moment progress actually stopped.
    recordProgress(row.taskId, activityAt > row.lastProgressAt ? activityAt : now, fingerprint);
    return;
  }

  if (row.progressFingerprint === "") {
    const confirmationGraceMs =
      !activeTool && !assistantResponse ? SILENT_RESPONSE_GRACE_MS : HANG_CONFIRM_GRACE_MS;
    recordProgress(row.taskId, now - timeoutMs + confirmationGraceMs, fingerprint);
    return;
  }

  if (now - activityAt < timeoutMs) return;
  await resolveHang(row);
}

export async function runHangWatchdogTick(): Promise<void> {
  if (watchdogTicking || !hooks) return;
  watchdogTicking = true;
  try {
    syncMemoryFromDisk();
    if (memoryWatches.size === 0) return;
    const timeoutMs = readHangTimeoutSettingMs();
    for (const row of [...memoryWatches.values()]) {
      if (row.state !== "armed") continue;
      try {
        await evaluateWatch(row, timeoutMs);
      } catch (error) {
        logWatchdog("evaluation failed", row, error);
      }
    }
  } finally {
    watchdogTicking = false;
  }
}

export function startHangWatchdog(): void {
  if (watchdogStarted) return;
  watchdogStarted = true;
  recoverInterruptedHangWatches();
  watchdogTimer = setInterval(() => {
    void runHangWatchdogTick();
  }, HANG_WATCHDOG_INTERVAL_MS);
  void runHangWatchdogTick();
}

export function stopHangWatchdogForTests(): void {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
  watchdogStarted = false;
  watchdogTicking = false;
  memoryWatches.clear();
}

export async function resolveHangNow(taskId: string): Promise<boolean> {
  const row = getTaskHangWatch(taskId);
  if (!row) return false;
  await resolveHang(row);
  return true;
}
