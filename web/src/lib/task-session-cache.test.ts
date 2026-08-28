import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadTaskSessionCache,
  saveTaskSessionCache,
  shouldKeepCachedBootstrapMessages,
  TASK_SESSION_CACHE_MAX_AGE_MS,
  TASK_SESSION_CACHE_STORAGE_KEY,
} from "./task-session-cache";
import type { TaskSummary, UiMessage } from "./types";

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
      task,
      messages,
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
    expect(stored.entries[task.id].task.messages).toBeUndefined();
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
});
