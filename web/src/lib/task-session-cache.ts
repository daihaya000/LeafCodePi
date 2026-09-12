import type { TaskDetail, TaskMessageHistory, TaskStatus, TaskSummary, ToolState, UiMessage, UiPart } from "@/lib/types";
import { dedupeUiMessages } from "./stabilize-messages";

export const TASK_SESSION_CACHE_STORAGE_KEY = "webui:task-session-cache";
export const TASK_SESSION_CACHE_VERSION = 2;
export const TASK_SESSION_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const TASK_SESSION_CACHE_MAX_ENTRIES = 20;

type CachedTaskSession = {
  cachedAt: number;
  task: TaskSummary;
  messages: UiMessage[];
  messageHistory?: TaskMessageHistory;
  isStreaming: boolean;
  isCompacting: boolean;
  contextUsage?: TaskDetail["contextUsage"];
};

type StoredTaskSessionCache = {
  version: typeof TASK_SESSION_CACHE_VERSION;
  entries: Record<string, CachedTaskSession>;
};

export type TaskSessionCacheSnapshot = Omit<CachedTaskSession, "cachedAt" | "task"> & {
  task: TaskSummary;
};

export function shouldKeepCachedBootstrapMessages(input: {
  currentTaskId: string | undefined;
  snapshotTaskId: string;
  isBootstrap: boolean;
  snapshotMessages: UiMessage[] | undefined;
  currentMessageCount: number;
}): boolean {
  return Boolean(
    input.isBootstrap &&
      input.currentTaskId === input.snapshotTaskId &&
      input.snapshotMessages?.length === 0 &&
      input.currentMessageCount > 0,
  );
}

const TASK_STATUSES = new Set<TaskStatus>([
  "working",
  "ready",
  "idle",
  "error",
  "archived",
  "unknown",
]);
const TOOL_STATUSES = new Set<ToolState["status"]>([
  "pending",
  "running",
  "completed",
  "cancelled",
  "error",
]);
const MESSAGE_ROLES = new Set<UiMessage["role"]>(["user", "assistant", "compaction"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskSummary(value: unknown): value is TaskSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (typeof value.projectId === "string" || value.projectId === null) &&
    typeof value.projectName === "string" &&
    typeof value.title === "string" &&
    typeof value.directory === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    TASK_STATUSES.has(value.status as TaskStatus)
  );
}

function isToolState(value: unknown): value is ToolState {
  if (!isRecord(value) || !TOOL_STATUSES.has(value.status as ToolState["status"])) return false;
  if (value.input !== undefined && !isRecord(value.input)) return false;
  if (value.output !== undefined && typeof value.output !== "string") return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (value.startedAtMs !== undefined && typeof value.startedAtMs !== "number") return false;
  if (value.endedAtMs !== undefined && typeof value.endedAtMs !== "number") return false;
  if (value.subagentRunIds !== undefined && !Array.isArray(value.subagentRunIds)) return false;
  return true;
}

function isUiPart(value: unknown): value is UiPart {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") return false;
  if (value.type === "text" || value.type === "thinking") return typeof value.text === "string";
  if (value.type === "image") {
    return typeof value.url === "string" && typeof value.mime === "string";
  }
  if (value.type === "tool") {
    return (
      typeof value.tool === "string" &&
      typeof value.callID === "string" &&
      isToolState(value.state)
    );
  }
  return false;
}

function isUiMessage(value: unknown): value is UiMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    MESSAGE_ROLES.has(value.role as UiMessage["role"]) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    Array.isArray(value.parts) &&
    value.parts.every(isUiPart)
  );
}

function isMessageHistory(value: unknown): value is TaskMessageHistory {
  return (
    isRecord(value) &&
    typeof value.hasMore === "boolean" &&
    (value.nextCursor === null || typeof value.nextCursor === "string")
  );
}

function isContextUsage(value: unknown): value is NonNullable<TaskDetail["contextUsage"]> {
  return (
    isRecord(value) &&
    (value.tokens === null || (typeof value.tokens === "number" && Number.isFinite(value.tokens))) &&
    typeof value.contextWindow === "number" &&
    Number.isFinite(value.contextWindow) &&
    value.contextWindow > 0 &&
    (value.percent === null || (typeof value.percent === "number" && Number.isFinite(value.percent)))
  );
}

function parseEntry(taskId: string, value: unknown): CachedTaskSession | null {
  if (!isRecord(value) || !isTaskSummary(value.task) || value.task.id !== taskId) return null;
  if (
    typeof value.cachedAt !== "number" ||
    !Number.isFinite(value.cachedAt) ||
    Date.now() - value.cachedAt > TASK_SESSION_CACHE_MAX_AGE_MS ||
    typeof value.isStreaming !== "boolean" ||
    typeof value.isCompacting !== "boolean" ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isUiMessage)
  ) {
    return null;
  }
  return {
    cachedAt: value.cachedAt,
    task: value.task,
    messages: dedupeUiMessages(value.messages),
    ...(isMessageHistory(value.messageHistory) ? { messageHistory: value.messageHistory } : {}),
    isStreaming: value.isStreaming,
    isCompacting: value.isCompacting,
    ...(isContextUsage(value.contextUsage) ? { contextUsage: value.contextUsage } : {}),
  };
}

function loadEntries(): Record<string, CachedTaskSession> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(TASK_SESSION_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== TASK_SESSION_CACHE_VERSION || !isRecord(parsed.entries)) {
      return {};
    }
    const entries: Record<string, CachedTaskSession> = {};
    for (const [taskId, value] of Object.entries(parsed.entries)) {
      const entry = parseEntry(taskId, value);
      if (entry) entries[taskId] = entry;
    }
    return entries;
  } catch {
    return {};
  }
}

function writeEntries(entries: Record<string, CachedTaskSession>): void {
  if (typeof localStorage === "undefined") return;
  const ordered = Object.fromEntries(
    Object.entries(entries)
      .sort(([, a], [, b]) => b.cachedAt - a.cachedAt)
      .slice(0, TASK_SESSION_CACHE_MAX_ENTRIES),
  );
  const stored: StoredTaskSessionCache = {
    version: TASK_SESSION_CACHE_VERSION,
    entries: ordered,
  };
  try {
    localStorage.setItem(TASK_SESSION_CACHE_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Quota: keep the newest task if older cached tabs filled localStorage.
    const newest = Object.entries(ordered).sort(([, a], [, b]) => b.cachedAt - a.cachedAt)[0];
    if (!newest) return;
    try {
      localStorage.setItem(
        TASK_SESSION_CACHE_STORAGE_KEY,
        JSON.stringify({ version: TASK_SESSION_CACHE_VERSION, entries: { [newest[0]]: newest[1] } }),
      );
    } catch {
      /* ignore */
    }
  }
}

export function loadTaskSessionCache(taskId: string): TaskDetail | null {
  const cached = loadEntries()[taskId];
  if (!cached) return null;
  return {
    ...cached.task,
    messages: cached.messages,
    ...(cached.messageHistory ? { messageHistory: cached.messageHistory } : {}),
    isStreaming: cached.isStreaming,
    isCompacting: cached.isCompacting,
    ...(cached.contextUsage ? { contextUsage: cached.contextUsage } : {}),
  };
}

export function saveTaskSessionCache(snapshot: TaskSessionCacheSnapshot): void {
  if (typeof localStorage === "undefined" || !isTaskSummary(snapshot.task)) return;
  if (!Array.isArray(snapshot.messages) || !snapshot.messages.every(isUiMessage)) return;
  const summary = { ...snapshot.task } as TaskSummary & Partial<TaskDetail>;
  delete summary.messages;
  delete summary.messageHistory;
  delete summary.isStreaming;
  delete summary.isCompacting;
  delete summary.contextUsage;
  delete summary.goalLoop;
  delete summary.todos;
  delete summary.permissionRequest;
  delete summary.questionRequest;
  delete summary.manualAbortedAssistantId;
  delete summary.hangRetryCount;
  const entries = loadEntries();
  entries[summary.id] = {
    ...snapshot,
    messages: dedupeUiMessages(snapshot.messages),
    task: summary,
    cachedAt: Date.now(),
  };
  writeEntries(entries);
}
