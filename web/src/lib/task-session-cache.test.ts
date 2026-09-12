import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadTaskSessionCache,
  saveTaskSessionCache,
  shouldKeepCachedBootstrapMessages,
  TASK_SESSION_CACHE_MAX_AGE_MS,
  TASK_SESSION_CACHE_STORAGE_KEY,
  TASK_SESSION_CACHE_VERSION,
} from "./task-session-cache";
import type { TaskMessageHistory, TaskSummary, UiMessage } from "./types";

class MemoryLocalStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const task: TaskSummary = {
  id: "task-1",
  projectId: "project-1",
  projectName: "Project",
  title: "Cached task",
  directory: "C:/work",
  isolation: "current_folder",
  status: "idle",
  sessionId: "session-1",
  sessionFile: "C:/sessions/task-1.jsonl",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
};

const messages: UiMessage[] = [
  {
    id: "message-1",
    role: "user",
    createdAt: 1,
    parts: [{ id: "message-1-text", type: "text", text: "Show cached content" }],
  },
];

beforeEach(() => {
  (globalThis as unknown as { localStorage?: MemoryLocalStorage }).localStorage = new MemoryLocalStorage();
});

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: MemoryLocalStorage }).localStorage;
});

describe("task session cache", () => {
  it("only keeps cached messages for the same task's empty bootstrap", () => {
    expect(shouldKeepCachedBootstrapMessages({
      currentTaskId: "task-1",
      snapshotTaskId: "task-1",
      isBootstrap: true,
      snapshotMessages: [],
      currentMessageCount: 1,
    })).toBe(true);
    expect(shouldKeepCachedBootstrapMessages({
      currentTaskId: "task-1",
      snapshotTaskId: "task-2",
      isBootstrap: true,
      snapshotMessages: [],
      currentMessageCount: 1,
    })).toBe(false);
    expect(shouldKeepCachedBootstrapMessages({
      currentTaskId: "task-1",
      snapshotTaskId: "task-1",
      isBootstrap: true,
      snapshotMessages: [messages[0]!],
      currentMessageCount: 1,
    })).toBe(false);
  });

  it("round-trips a task snapshot without storing duplicate TaskDetail fields", () => {
    saveTaskSessionCache({
      task: {
        ...task,
        permissionRequest: { id: "req-1" },
        questionRequest: { id: "q-1" },
        manualAbortedAssistantId: "",
        hangRetryCount: 2,
      } as TaskSummary,
      messages,
      messageHistory: { hasMore: true, nextCursor: "message-1" } satisfies TaskMessageHistory,
      isStreaming: false,
      isCompacting: false,
      contextUsage: { tokens: 12, contextWindow: 100, percent: 12 },
    });

    const loaded = loadTaskSessionCache(task.id);
    expect(loaded).toMatchObject({
      id: task.id,
      title: task.title,
      messages,
      isStreaming: false,
      isCompacting: false,
      contextUsage: { tokens: 12, contextWindow: 100, percent: 12 },
    });
    const stored = JSON.parse(localStorage.getItem(TASK_SESSION_CACHE_STORAGE_KEY) ?? "{}");
    expect(loaded?.messageHistory).toEqual({ hasMore: true, nextCursor: "message-1" });
    expect(stored.entries[task.id].messageHistory).toEqual({ hasMore: true, nextCursor: "message-1" });
    expect(stored.entries[task.id].task.messages).toBeUndefined();
    expect(stored.entries[task.id].task.messageHistory).toBeUndefined();
    expect(stored.entries[task.id].task.manualAbortedAssistantId).toBeUndefined();
    expect(stored.entries[task.id].task.hangRetryCount).toBeUndefined();
    expect(stored.entries[task.id].task.permissionRequest).toBeUndefined();
  });

  it("removes legacy duplicate rows when loading a cached session", () => {
    const streamed: UiMessage = {
      id: "msg-3",
      role: "assistant",
      createdAt: 2,
      parts: [{ id: "msg-3-text", type: "text", text: "reply" }],
    };
    const persisted = { ...streamed, id: "entry-42" };
    localStorage.setItem(
      TASK_SESSION_CACHE_STORAGE_KEY,
      JSON.stringify({
        version: TASK_SESSION_CACHE_VERSION,
        entries: {
          [task.id]: {
            cachedAt: Date.now(),
            task,
            messages: [streamed, persisted],
            isStreaming: false,
            isCompacting: false,
          },
        },
      }),
    );

    expect(loadTaskSessionCache(task.id)?.messages).toEqual([persisted]);
  });

  it("ignores malformed, expired, and structurally unsafe entries", () => {
    localStorage.setItem(TASK_SESSION_CACHE_STORAGE_KEY, "{broken");
    expect(loadTaskSessionCache(task.id)).toBeNull();

    localStorage.setItem(
      TASK_SESSION_CACHE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: {
          [task.id]: {
            cachedAt: Date.now(),
            task,
            messages: [{ id: "bad", role: "assistant", createdAt: 1, parts: [{ type: "unknown" }] }],
            isStreaming: false,
            isCompacting: false,
          },
        },
      }),
    );
    expect(loadTaskSessionCache(task.id)).toBeNull();

    saveTaskSessionCache({ task, messages, isStreaming: false, isCompacting: false });
    const stored = JSON.parse(localStorage.getItem(TASK_SESSION_CACHE_STORAGE_KEY) ?? "{}");
    stored.entries[task.id].cachedAt = Date.now() - TASK_SESSION_CACHE_MAX_AGE_MS - 1;
    localStorage.setItem(TASK_SESSION_CACHE_STORAGE_KEY, JSON.stringify(stored));
    expect(loadTaskSessionCache(task.id)).toBeNull();
  });

  it("keeps only the newest entries when the cache overflows", () => {
    const snapshot = (taskId: string) => ({
      task: { ...task, id: taskId },
      messages,
      isStreaming: false,
      isCompacting: false,
    });
    for (let index = 0; index < 25; index += 1) {
      saveTaskSessionCache(snapshot(`task-${index}`) as never);
    }
    const stored = JSON.parse(localStorage.getItem(TASK_SESSION_CACHE_STORAGE_KEY) ?? "{}");
    const ids = Object.keys(stored.entries);
    // 上限を超えて増えない（cachedAt 順序は Date.now 依存のため件数のみ検証）
    expect(ids).toHaveLength(20);
  });

  it("falls back to the newest entry when the full write overflows quota", () => {
    const snapshot = (taskId: string) => ({
      task: { ...task, id: taskId },
      messages,
      isStreaming: false,
      isCompacting: false,
    });
    const original = MemoryLocalStorage.prototype.setItem;
    const spy = vi
      .spyOn(MemoryLocalStorage.prototype, "setItem")
      .mockImplementation(function (this: MemoryLocalStorage, key: string, value: string) {
        // 1回目（全エントリのフル書き込み）だけ quota で失敗させる
        if (spy.mock.calls.length === 1) throw new Error("QuotaExceededError");
        original.call(this, key, value);
      });
    saveTaskSessionCache(snapshot("task-20") as never);
    spy.mockRestore();
    const stored = JSON.parse(localStorage.getItem(TASK_SESSION_CACHE_STORAGE_KEY) ?? "{}");
    expect(Object.keys(stored.entries)).toEqual(["task-20"]);
  });
});
