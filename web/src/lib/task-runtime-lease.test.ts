import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireTaskLease, releaseTaskLease, reconcileOrphanedWorkingTasks, ORPHANED_WORKING_TASK_ERROR } from "./task-runtime-lease";
import { insertTask, getTask, patchTask } from "./store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.LEAFCODE_PI_DATA_DIR;
  delete process.env.LEAFCODE_PI_DEFAULT_DIR;
});

describe("task runtime restart reconciliation", () => {
  it("keeps leased work and fails an orphaned working task without dispatching it", () => {
    const dir = join(tmpdir(), `leafcode-reconcile-${Date.now()}-${Math.random()}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.LEAFCODE_PI_DEFAULT_DIR = join(dir, "workspaces");

    const live = insertTask({ project: null, title: "live" });
    patchTask(live.id, { status: "working" });
    expect(acquireTaskLease(live.id)).toBe(true);
    expect(reconcileOrphanedWorkingTasks()).toEqual([]);
    expect(getTask(live.id)?.status).toBe("working");

    const orphan = insertTask({ project: null, title: "orphan" });
    patchTask(orphan.id, { status: "working" });
    expect(reconcileOrphanedWorkingTasks()).toEqual([orphan.id]);
    expect(getTask(orphan.id)).toMatchObject({ status: "error", error: ORPHANED_WORKING_TASK_ERROR });
    expect(reconcileOrphanedWorkingTasks()).toEqual([]);
    releaseTaskLease(live.id);
  });
});