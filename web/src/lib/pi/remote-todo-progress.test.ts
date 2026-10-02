import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityFromDetail,
  fetchRemoteCodeProgress,
  fetchRemoteTodoProgress,
  fetchRemoteTodoProgressMany,
  needsRemoteTodoProgress,
  todoProgressFromDetail,
} from "./remote-todo-progress";

const mocks = vi.hoisted(() => ({
  forwardTaskDetail: vi.fn(),
}));
vi.mock("@/lib/backend-forward", () => mocks);

describe("remote-todo-progress", () => {
  beforeEach(() => {
    mocks.forwardTaskDetail.mockReset();
  });

  it("prefers detail.todoProgress then projects todos", () => {
    expect(todoProgressFromDetail({
      todoProgress: { total: 2, completed: 1 },
    })).toEqual({ total: 2, completed: 1 });
    expect(todoProgressFromDetail({
      todos: [
        { id: "1", content: "a", status: "completed", priority: "medium" },
        { id: "2", content: "b", status: "in_progress", priority: "medium" },
      ],
    })).toEqual({ total: 2, completed: 1 });
    expect(todoProgressFromDetail(null)).toBeUndefined();
  });

  it("reads activity from omit detail", () => {
    expect(activityFromDetail({ activity: "読取 README.md" })).toBe("読取 README.md");
    expect(activityFromDetail({ activity: "   " })).toBeUndefined();
    expect(activityFromDetail(null)).toBeUndefined();
  });

  it("shares in-flight omit detail reads for the same task", async () => {
    let resolve!: (value: unknown) => void;
    mocks.forwardTaskDetail.mockReturnValue(new Promise((done) => { resolve = done; }));
    const first = fetchRemoteCodeProgress("task-1");
    const second = fetchRemoteTodoProgress("task-1");
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(1);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledWith("task-1", { messages: "omit" });
    resolve({
      ok: true,
      detail: { todoProgress: { total: 1, completed: 0 }, activity: "検索" },
    });
    await expect(first).resolves.toEqual({ todoProgress: { total: 1, completed: 0 }, activity: "検索" });
    await expect(second).resolves.toEqual({ total: 1, completed: 0 });
  });

  it("fetches many task ids with bounded concurrency", async () => {
    mocks.forwardTaskDetail.mockImplementation(async (id: string) => ({
      ok: true,
      detail: { todoProgress: { total: 1, completed: id === "a" ? 1 : 0 } },
    }));
    const map = await fetchRemoteTodoProgressMany(["a", "b", "a"], 2);
    expect([...map.keys()].sort()).toEqual(["a", "b"]);
    expect(mocks.forwardTaskDetail).toHaveBeenCalledTimes(2);
  });

  it("needs the owner read only for working or live Goal Loop tasks", () => {
    expect(needsRemoteTodoProgress("working", null)).toBe(true);
    expect(needsRemoteTodoProgress("idle", "queued")).toBe(true);
    expect(needsRemoteTodoProgress("idle", "running")).toBe(true);
    expect(needsRemoteTodoProgress("idle", "verifying_completed")).toBe(true);
    // A finished/held loop cannot advance, so the persisted state is authoritative.
    expect(needsRemoteTodoProgress("idle", "completed")).toBe(false);
    expect(needsRemoteTodoProgress("idle", "stopped")).toBe(false);
    expect(needsRemoteTodoProgress("idle", "paused")).toBe(false);
    expect(needsRemoteTodoProgress("idle", undefined)).toBe(false);
  });

  it("returns empty progress when the Backend omit read fails", async () => {
    mocks.forwardTaskDetail.mockResolvedValue({ ok: false, reason: "unreachable" });
    await expect(fetchRemoteCodeProgress("task-1")).resolves.toEqual({});
    await expect(fetchRemoteTodoProgress("task-1")).resolves.toBeUndefined();
  });
});
