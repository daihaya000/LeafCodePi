import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireTaskLease, releaseTaskLease, reconcileOrphanedWorkingTasks, setOrphanedTaskListener, taskRuntimeLeasePath, ORPHANED_WORKING_TASK_ERROR } from "./task-runtime-lease";
import { insertBotTask, insertTask, getTask, patchTask } from "./store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.LEAFCODE_PI_DATA_DIR;
  delete process.env.LEAFCODE_PI_DEFAULT_DIR;
});

describe("task runtime restart reconciliation", () => {
  it("shares ownership across module reloads and releases from either instance", async () => {
    const dir = join(tmpdir(), `leafcode-reload-lease-${Date.now()}-${Math.random()}`);
    dirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    expect(acquireTaskLease("reload")).toBe(true);
    try {
      vi.resetModules();
      const reloaded = await import("./task-runtime-lease");
      expect(reloaded.acquireTaskLease("reload")).toBe(true);
      reloaded.releaseTaskLease("reload");
      expect(reloaded.hasActiveTaskLease("reload")).toBe(false);
    } finally {
      releaseTaskLease("reload");
    }
  });
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

    const botOrphan = insertBotTask({ id: "bot:orphan", botId: "orphan-bot", name: "Bot orphan", directory: join(dir, "bot-workspace") });
    patchTask(botOrphan.id, { status: "working" });
    expect(reconcileOrphanedWorkingTasks()).toContain(botOrphan.id);
    expect(getTask(botOrphan.id)).toMatchObject({ status: "error", error: ORPHANED_WORKING_TASK_ERROR });
    expect(reconcileOrphanedWorkingTasks()).toEqual([]);
    releaseTaskLease(live.id);
  });

  it("offers orphaned working snapshots to the listener, replaying ones reconciled before registration", () => {
    const dir = join(tmpdir(), `leafcode-orphan-listener-${Date.now()}-${Math.random()}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.LEAFCODE_PI_DEFAULT_DIR = join(dir, "workspaces");
    // Drain orphans buffered by earlier tests in this worker.
    setOrphanedTaskListener(() => undefined);
    setOrphanedTaskListener(null);
    try {
      const early = insertTask({ project: null, title: "early" });
      const workingUpdatedAt = patchTask(early.id, { status: "working" })!.updatedAt;
      expect(reconcileOrphanedWorkingTasks()).toEqual([early.id]);

      const received: { id: string; status: string }[][] = [];
      let earlyUpdatedAt = "";
      setOrphanedTaskListener((tasks) => {
        if (!earlyUpdatedAt) earlyUpdatedAt = tasks[0]?.updatedAt ?? "";
        received.push(tasks.map(({ id, status }) => ({ id, status })));
      });
      expect(received).toEqual([[{ id: early.id, status: "working" }]]);
      expect(earlyUpdatedAt).toBe(workingUpdatedAt);

      const late = insertTask({ project: null, title: "late" });
      patchTask(late.id, { status: "working" });
      reconcileOrphanedWorkingTasks();
      expect(received[1]).toEqual([{ id: late.id, status: "working" }]);
      // Nothing new is orphaned, so the listener is not called again.
      reconcileOrphanedWorkingTasks();
      expect(received).toHaveLength(2);

      setOrphanedTaskListener(() => { throw new Error("listener failure"); });
      const failing = insertTask({ project: null, title: "failing" });
      patchTask(failing.id, { status: "working" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(reconcileOrphanedWorkingTasks()).toEqual([failing.id]);
      } finally {
        warn.mockRestore();
      }
    } finally {
      setOrphanedTaskListener(null);
    }
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