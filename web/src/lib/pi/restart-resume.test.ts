import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORPHANED_WORKING_TASK_ERROR } from "@/lib/task-runtime-lease";
import type { TaskSummary } from "@/lib/types";
import {
  RESTART_RESUME_DELAY_MS,
  RESTART_RESUME_MAX_ATTEMPTS,
  RESTART_RESUME_MAX_STALE_MS,
  RESTART_RESUME_PROMPT,
  RESTART_RESUME_STAGGER_MS,
  RESTART_RESUME_WINDOW_MS,
  handleOrphanedTasks,
  resumeOrphanedTask,
  type RestartResumeDeps,
} from "./restart-resume";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
let dir = "";

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "t1",
    kind: "code",
    projectId: null,
    projectName: "",
    title: "t",
    directory: "C:/work",
    isolation: "current_folder",
    status: "working",
    sessionId: "s1",
    sessionFile: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 10_000).toISOString(),
    ...overrides,
  } as TaskSummary;
}

function deps(stored: TaskSummary | undefined, overrides: Partial<RestartResumeDeps> = {}) {
  const promptTask = vi.fn<RestartResumeDeps["promptTask"]>(() => Promise.resolve({}));
  const scheduled: { callback: () => void; delayMs: number }[] = [];
  const value: RestartResumeDeps = {
    getTask: () => stored,
    promptTask,
    isGoalLoopOwned: () => false,
    isRoomDelegated: () => false,
    now: () => NOW,
    schedule: (callback, delayMs) => { scheduled.push({ callback, delayMs }); },
    log: () => undefined,
    ...overrides,
  };
  return { value, promptTask, scheduled };
}

const orphaned = (overrides: Partial<TaskSummary> = {}) =>
  task({ status: "error", error: ORPHANED_WORKING_TASK_ERROR, ...overrides });

beforeEach(() => {
  dir = join(tmpdir(), `leafcode-restart-resume-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  process.env.LEAFCODE_PI_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LEAFCODE_PI_DATA_DIR;
});

describe("restart resume", () => {
  it("schedules eligible Code tasks and resumes them with the restart prompt", async () => {
    const { value, promptTask, scheduled } = deps(orphaned());
    expect(handleOrphanedTasks([task()], value)).toEqual(["t1"]);
    expect(promptTask).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(RESTART_RESUME_DELAY_MS);

    scheduled[0]!.callback();
    await vi.waitFor(() => expect(promptTask).toHaveBeenCalledWith("t1", RESTART_RESUME_PROMPT));
  });

  it("staggers multiple resumes", () => {
    const { value, scheduled } = deps(orphaned());
    expect(handleOrphanedTasks([task({ id: "a" }), task({ id: "b", botId: "x" }), task({ id: "c" })], value)).toEqual(["a", "c"]);
    expect(scheduled.map((item) => item.delayMs)).toEqual([RESTART_RESUME_DELAY_MS, RESTART_RESUME_DELAY_MS + RESTART_RESUME_STAGGER_MS]);
  });

  it("skips Bot, supervised, and long-stale tasks before scheduling", () => {
    const { value, scheduled } = deps(orphaned());
    const scheduledIds = handleOrphanedTasks([
      task({ id: "bot", kind: "bot" }),
      task({ id: "bot-code", botId: "b1" }),
      task({ id: "supervised", supervisorBotId: "b1" }),
      task({ id: "stale", updatedAt: new Date(NOW - RESTART_RESUME_MAX_STALE_MS - 1).toISOString() }),
    ], value);
    expect(scheduledIds).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  it("does not resume when the user already acted, a Goal Loop owns it, or it belongs to a Room", async () => {
    for (const stored of [undefined, task({ status: "working" }), orphaned({ error: "other" }), task({ status: "idle", error: null })]) {
      const { value, promptTask } = deps(stored);
      expect(await resumeOrphanedTask(task(), value)).toBe(false);
      expect(promptTask).not.toHaveBeenCalled();
    }
    const goal = deps(orphaned(), { isGoalLoopOwned: () => true });
    expect(await resumeOrphanedTask(task(), goal.value)).toBe(false);
    const room = deps(orphaned(), { isRoomDelegated: () => true });
    expect(await resumeOrphanedTask(task(), room.value)).toBe(false);
    expect(goal.promptTask).not.toHaveBeenCalled();
    expect(room.promptTask).not.toHaveBeenCalled();
  });

  it("caps restart resumes per task within the window and counts again afterwards", async () => {
    let now = NOW;
    const { value, promptTask } = deps(orphaned(), { now: () => now });
    for (let attempt = 0; attempt < RESTART_RESUME_MAX_ATTEMPTS; attempt += 1) {
      expect(await resumeOrphanedTask(task(), value)).toBe(true);
    }
    expect(await resumeOrphanedTask(task(), value)).toBe(false);
    expect(promptTask).toHaveBeenCalledTimes(RESTART_RESUME_MAX_ATTEMPTS);

    now += RESTART_RESUME_WINDOW_MS + 1;
    expect(await resumeOrphanedTask(task(), value)).toBe(true);
  });

  it("reports a failed resume without throwing", async () => {
    const log = vi.fn();
    const { value } = deps(orphaned(), {
      promptTask: () => Promise.reject(new Error("provider down")),
      log,
    });
    expect(await resumeOrphanedTask(task(), value)).toBe(false);
    expect(log).toHaveBeenCalledWith("resume failed for t1", expect.any(Error));
  });
});
