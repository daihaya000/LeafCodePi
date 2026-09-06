import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireTaskLease, releaseTaskLease, reconcileOrphanedWorkingTasks, taskRuntimeLeasePath, ORPHANED_WORKING_TASK_ERROR } from "./task-runtime-lease";
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

  it("does not steal a lease whose PID is alive after the heartbeat age threshold", () => {
    const dir = join(tmpdir(), `leafcode-live-lease-${Date.now()}-${Math.random()}`);
    dirs.push(dir);
    mkdirSync(join(dir, "task-leases"), { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    writeFileSync(taskRuntimeLeasePath("busy"), JSON.stringify({ token: "other", pid: process.pid, acquiredAt: Date.now() - 120_000, heartbeatAt: Date.now() - 120_000 }));
    expect(acquireTaskLease("busy")).toBe(false);
  });

  it("reclaims a dead stale lease without recursive acquisition", () => {
    const dir = join(tmpdir(), `leafcode-stale-lease-${Date.now()}-${Math.random()}`);
    dirs.push(dir);
    mkdirSync(join(dir, "task-leases"), { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    writeFileSync(taskRuntimeLeasePath("recover"), JSON.stringify({ token: "dead", pid: 999999, acquiredAt: Date.now() - 120_000, heartbeatAt: Date.now() - 120_000 }));
    expect(acquireTaskLease("recover")).toBe(true);
    releaseTaskLease("recover");
  });
});