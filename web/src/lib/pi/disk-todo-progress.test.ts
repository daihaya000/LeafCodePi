import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDiskTodoProgressCacheForTests,
  readDiskTodoProgress,
} from "./disk-todo-progress";

const tempDirs: string[] = [];

afterEach(() => {
  clearDiskTodoProgressCacheForTests();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionWithTodos(
  name: string,
  todos: { id: string; content: string; status: string; priority: string }[],
): string {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-disk-todo-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", id: "s1", version: 1 }),
      JSON.stringify({
        type: "message",
        id: "m1",
        message: {
          role: "toolResult",
          toolName: "todowrite",
          details: { todos },
          content: [],
          timestamp: 1,
        },
      }),
    ].join("\n"),
    "utf8",
  );
  return file;
}

describe("readDiskTodoProgress", () => {
  it("projects Todo bars from a shared session file without Pi SessionManager", () => {
    const sessionFile = sessionWithTodos("idle.session", [
      { id: "t1", content: "完了", status: "completed", priority: "high" },
      { id: "t2", content: "作業中", status: "in_progress", priority: "medium" },
    ]);
    expect(readDiskTodoProgress(sessionFile)).toEqual({ completed: 1, total: 2 });
  });

  it("reuses the mtime cache while the file is unchanged", () => {
    const sessionFile = sessionWithTodos("cached.session", [
      { id: "t1", content: "一つ", status: "completed", priority: "medium" },
    ]);
    expect(readDiskTodoProgress(sessionFile)).toEqual({ completed: 1, total: 1 });
    expect(readDiskTodoProgress(sessionFile)).toEqual({ completed: 1, total: 1 });

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "s1", version: 1 }),
        JSON.stringify({
          type: "message",
          id: "m2",
          message: {
            role: "toolResult",
            toolName: "todowrite",
            details: {
              todos: [
                { id: "t1", content: "一つ", status: "completed", priority: "medium" },
                { id: "t2", content: "二つ", status: "pending", priority: "low" },
              ],
            },
            content: [],
            timestamp: 2,
          },
        }),
      ].join("\n"),
      "utf8",
    );
    expect(readDiskTodoProgress(sessionFile)).toEqual({ completed: 1, total: 2 });
  });

  it("returns undefined for missing files or empty Todo lists", () => {
    expect(readDiskTodoProgress(null)).toBeUndefined();
    expect(readDiskTodoProgress(join("C:", "no-such-session.jsonl"))).toBeUndefined();
    expect(readDiskTodoProgress(sessionWithTodos("empty.session", []))).toBeUndefined();
  });
});
