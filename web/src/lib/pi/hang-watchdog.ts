/**
 * Pi セッション向けハング watchdog（本家 LeafCode の hang-watchdog.ts 相当）。
 * OpenCode API の代わりに harness の LiveRuntime を直接監視する。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import type { UiMessage } from "@/lib/types";

export const HANG_WATCHDOG_INTERVAL_MS = 15_000;
export const MAX_WATCH_BODY_BYTES = 2_000_000;
export const HANG_CONFIRM_GRACE_MS = 30_000;
export const SILENT_RESPONSE_GRACE_MS = 30_000;

export type TaskHangWatchRow = {
  taskId: string;
  prompt: string;
  images: PromptImage[];
  agent?: string;
  subagentPermission?: "allow" | "deny";
  permissionMode?: "allow" | "ask" | "deny";
  resumeAllowed: boolean;
  startedAt: number;
  lastProgressAt: number;
  progressFingerprint: string;
  retryUsed: number;
  state: "armed" | "resolving";
  updatedAt: number;
};

export type ArmTaskHangWatchInput = {
  taskId: string;
  prompt: string;
  images?: PromptImage[];
  agent?: string;
  subagentPermission?: "allow" | "deny";
  permissionMode?: "allow" | "ask" | "deny";
  startedAt?: number;
  isHangRetry?: boolean;
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
      agent?: string;
      subagentPermission?: "allow" | "deny";
      permissionMode?: "allow" | "ask" | "deny";
    },
  ) => void;
  notifyHangRetry: (taskId: string, retryCount: number) => void;
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
let idleWaitAttempts = 6;
let idleWaitIntervalMs = 1_000;

function watchesPath(): string {
  return join(dataDir(), "hang-watches.json");
}

function readStore(): WatchStore {
  try {
    const parsed = JSON.parse(readFileSync(watchesPath(), "utf8")) as WatchStore;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.watches)) {
      return { version: 1, watches: [] };
    }
    return parsed;
  } catch {
    return { version: 1, watches: [] };
  }
}

function writeStore(): void {
  const file = watchesPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ version: 1, watches: [...memoryWatches.values()] }, null, 2)}\n`,
    "utf8",
  );
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
}): number {
  let total = input.prompt.length;
  for (const image of input.images ?? []) {
    total += image.data.length + (image.mimeType?.length ?? 0);
  }
  return total;
}

export function progressFingerprint(messages: UiMessage[]): string {
  return messages
    .map((message) => {
      const parts = message.parts
        .map((part) => {
          if (part.type === "text") return `t:${part.text.length}`;
          if (part.type === "thinking") return `k:${part.text.length}`;
          if (part.type === "tool") return `o:${part.state.status}`;
          if (part.type === "image") return "i:1";
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

function syncMemoryFromDisk(): void {
  memoryWatches.clear();
  for (const row of readStore().watches) {
    memoryWatches.set(row.taskId, row);
  }
}

export function recoverInterruptedHangWatches(): void {
  syncMemoryFromDisk();
  for (const row of memoryWatches.values()) {
    if (row.state === "resolving") {
      row.state = "armed";
      row.updatedAt = Date.now();
    }
  }
  writeStore();
}

export function armTaskHangWatch(input: ArmTaskHangWatchInput): void {
  const taskId = input.taskId.trim();
  if (!taskId) return;
  if (!input.prompt.trim() && (input.images?.length ?? 0) === 0) return;

  const bodyBytes = estimateWatchBodyBytes({ prompt: input.prompt, images: input.images });
  const resumeAllowed = bodyBytes <= MAX_WATCH_BODY_BYTES;
  const startedAt = input.startedAt ?? Date.now();
  const preserveRetry = input.isHangRetry === true;
  const existing = memoryWatches.get(taskId);

  const row: TaskHangWatchRow = {
    taskId,
    prompt: input.prompt,
    images: input.images ?? [],
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.subagentPermission ? { subagentPermission: input.subagentPermission } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
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

function markResolving(taskId: string): boolean {
  const row = memoryWatches.get(taskId);
  if (!row || row.state === "resolving") return false;
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
  if (!markResolving(row.taskId)) return;
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

  const resumeMode = readAutoResumeModeSetting();
  const attachImages =
    row.resumeAllowed &&
    shouldAttachResumeImages(resumeMode, row.prompt, row.images.length);
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
    images: attachImages ? row.images : [],
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.subagentPermission ? { subagentPermission: row.subagentPermission } : {}),
    ...(row.permissionMode ? { permissionMode: row.permissionMode } : {}),
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
    // WebUI restart can temporarily detach the session. Keep the persisted
    // watch so it can resume when the task is reattached.
    logWatchdog("live session missing — keeping the watch", row);
    return;
  }

  const { messages, isStreaming, isCompacting, hasPendingAttention } = live;
  // Compaction temporarily makes the session idle-looking while the previous
  // turn is being rewritten. Never abort or resume against that intermediate
  // transcript; the next tick will evaluate the compacted branch.
  if (isCompacting) return;
  if (turnHasOnlyActiveSubagentTool(messages, row.startedAt)) return;
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
    recordProgress(row.taskId, Math.max(activityAt, fingerprintChanged ? now : 0), fingerprint);
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

export function setHangWatchdogIdleWaitForTests(attempts: number, intervalMs: number): void {
  idleWaitAttempts = attempts;
  idleWaitIntervalMs = intervalMs;
}

export async function resolveHangNow(taskId: string): Promise<boolean> {
  const row = getTaskHangWatch(taskId);
  if (!row) return false;
  await resolveHang(row);
  return true;
}
