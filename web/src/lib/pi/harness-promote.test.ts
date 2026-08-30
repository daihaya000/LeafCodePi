import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { insertTask, patchTask } from "@/lib/store";
import { promoteTask } from "./harness";

const GLOBAL_KEY = "__leafcodePiHarness";
const roots: string[] = [];

function setHarness(pi: unknown) {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    pi,
    live: new Map(),
    events: new EventEmitter(),
    lastProviderSyncWarnings: [],
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  delete process.env.LEAFCODE_PI_DATA_DIR;
  delete process.env.LEAFCODE_PI_DEFAULT_DIR;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("promoteTask", () => {
  it("forks the session, registers the destination, and moves the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-promote-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const noProjectRoot = join(root, "no-project");
    const destination = join(root, "project");
    process.env.LEAFCODE_PI_DATA_DIR = dataDir;
    process.env.LEAFCODE_PI_DEFAULT_DIR = noProjectRoot;
    const task = insertTask({ project: null, title: "temporary" });
    const source = task.directory;
    const sessionFile = join(source, "session.json");
    writeFileSync(sessionFile, "session\n", "utf8");
    writeFileSync(join(source, "result.txt"), "done\n", "utf8");
    patchTask(task.id, { sessionId: "old-session", sessionFile });

    let forkCwd = "";
    setHarness({
      SessionManager: {
        forkFrom: (file: string, cwd: string) => {
          expect(file).toBe(sessionFile);
          forkCwd = cwd;
          const forkedFile = join(cwd, "forked-session.json");
          writeFileSync(forkedFile, "forked\n", "utf8");
          return {
            getSessionFile: () => forkedFile,
            getSessionId: () => "new-session",
          };
        },
      },
    });

    const result = await promoteTask(task.id, destination);

    expect(forkCwd).toBe(destination);
    expect(result.project.rootPath).toBe(destination);
    expect(result.task.projectId).toBe(result.project.id);
    expect(result.task.directory).toBe(destination);
    expect(result.task.sessionId).toBe("new-session");
    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(destination, "result.txt"))).toBe(true);
    expect(existsSync(join(destination, "forked-session.json"))).toBe(true);
  });

  it("rejects a working task without changing its workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-promote-"));
    roots.push(root);
    const noProjectRoot = join(root, "no-project");
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    process.env.LEAFCODE_PI_DEFAULT_DIR = noProjectRoot;
    const task = insertTask({ project: null, title: "working" });
    const source = task.directory;
    patchTask(task.id, { status: "working" });

    await expect(promoteTask(task.id, join(root, "project"))).rejects.toThrow(
      "実行中のタスクは停止してから昇進してください",
    );
    expect(existsSync(source)).toBe(true);
  });
});
