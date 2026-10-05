import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireTaskLease, releaseTaskLease } from "@/lib/task-runtime-lease";
import { readTodoProgress } from "./harness";

const tempDirs: string[] = [];
const leasedTasks: string[] = [];
const originalDataDir = process.env.LEAFCODE_PI_DATA_DIR;

afterEach(() => {
  for (const taskId of leasedTasks.splice(0)) releaseTaskLease(taskId);
  if (originalDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = originalDataDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakePi(openCount: () => void) {
  return {
    SessionManager: {
      open: (sessionFile: string) => {
        openCount();
        const content = JSON.parse(readFileSync(sessionFile, "utf8")) as {
          todos: { status: string; priority: string; content: string }[];
        };
        return {
          buildSessionContext: () => ({
            messages: [
              {
                role: "toolResult",
                toolName: "todowrite",
                details: { todos: content.todos },
              },
            ],
          }),
        };
      },
    },
  };
}

describe("readTodoProgress", () => {
  it("skips reopening the session file while it is unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-todo-progress-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const sessionFile = join(dir, "session.jsonl");
    const taskId = "todo-progress-task";
    expect(acquireTaskLease(taskId)).toBe(true);
    leasedTasks.push(taskId);
    let opens = 0;
    const pi = fakePi(() => {
      opens += 1;
    });

    writeFileSync(sessionFile, JSON.stringify({ todos: [{ status: "completed", content: "作業1", priority: "medium" }] }), "utf8");
    expect(readTodoProgress(pi as never, { id: taskId, sessionFile } as never)).toEqual({ completed: 1, total: 1 });
    expect(opens).toBe(1);

    // Same file on disk: cache hit, no reopen.
    expect(readTodoProgress(pi as never, { id: taskId, sessionFile } as never)).toEqual({ completed: 1, total: 1 });
    expect(opens).toBe(1);

    // File changed on disk: reopen and recompute.
    writeFileSync(
      sessionFile,
      JSON.stringify({
        todos: [
          { status: "completed", content: "作業", priority: "medium" },
          { status: "pending", content: "次の作業", priority: "low" },
        ],
      }),
      "utf8",
    );
    expect(readTodoProgress(pi as never, { id: taskId, sessionFile } as never)).toEqual({ completed: 1, total: 2 });
    expect(opens).toBe(2);
  });
});
