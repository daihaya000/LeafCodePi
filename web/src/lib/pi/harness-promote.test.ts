import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTask, insertTask, listProjects, patchTask } from "@/lib/store";
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

  it("rolls back the copied workspace when session forking fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-promote-"));
    roots.push(root);
    const noProjectRoot = join(root, "no-project");
    const destination = join(root, "project");
    mkdirSync(destination);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    process.env.LEAFCODE_PI_DEFAULT_DIR = noProjectRoot;
    const task = insertTask({ project: null, title: "temporary" });
    const source = task.directory;
    const sessionFile = join(source, "session.json");
    writeFileSync(sessionFile, "session\n", "utf8");
    patchTask(task.id, { sessionId: "old-session", sessionFile });
    setHarness({
      SessionManager: {
        forkFrom: () => {
          throw new Error("fork failed");
        },
      },
    });

    await expect(promoteTask(task.id, destination)).rejects.toThrow("fork failed");
    expect(existsSync(source)).toBe(true);
    expect(readdirSync(destination)).toHaveLength(0);
    expect(getTask(task.id)).toMatchObject({ projectId: null, directory: source });
    expect(listProjects(true)).toHaveLength(0);
  });

  it("serializes promotions that target the same destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-promote-"));
    roots.push(root);
    const noProjectRoot = join(root, "no-project");
    const destination = join(root, "project");
    mkdirSync(destination);
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    process.env.LEAFCODE_PI_DEFAULT_DIR = noProjectRoot;
    const first = insertTask({ project: null, title: "first" });
    const second = insertTask({ project: null, title: "second" });
    for (const task of [first, second]) {
      writeFileSync(join(task.directory, "session.json"), "session\n", "utf8");
      patchTask(task.id, { sessionId: `${task.id}-session`, sessionFile: join(task.directory, "session.json") });
    }

    let forkCount = 0;
    setHarness({
      SessionManager: {
        forkFrom: () => {
          forkCount += 1;
          const forkedFile = join(root, `forked-${forkCount}.json`);
          writeFileSync(forkedFile, "forked\n", "utf8");
          return {
            getSessionFile: () => forkedFile,
            getSessionId: () => `new-session-${forkCount}`,
          };
        },
      },
    });

    const outcomes = await Promise.allSettled([
      promoteTask(first.id, destination),
      promoteTask(second.id, destination),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(forkCount).toBe(1);
    expect(existsSync(destination)).toBe(true);
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
