import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createTaskLeaseState, TaskLeaseService, HEARTBEAT_MS, TASK_LEASE_STALE_MS, ORPHANED_WORKING_TASK_ERROR } from "./task-runtime-lease.mjs";

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-backend-task-lease-"));
  const rows = [];
  const timers = [];
  const warnings = [];
  const state = options.state ?? createTaskLeaseState();
  const service = new TaskLeaseService({
    dataDir: () => root,
    listTasks: () => rows,
    patchTask: (id, patch) => {
      const row = rows.find((task) => task.id === id);
      if (row) Object.assign(row, patch, { updatedAt: "after" });
      return row;
    },
    state,
    setHeartbeat: (callback, delayMs) => {
      const timer = { callback, delayMs, unrefs: 0, cleared: false, unref() { this.unrefs += 1; } };
      timers.push(timer);
      return timer;
    },
    clearHeartbeat: (timer) => { timer.cleared = true; },
    warn: (...args) => { warnings.push(args); },
    ...options,
  });
  t.after(() => { service.stopHeartbeat(); rmSync(root, { recursive: true, force: true }); });
  return { root, rows, state, timers, warnings, service };
}

function record(service, id) {
  return JSON.parse(readFileSync(service.taskRuntimeLeasePath(id), "utf8"));
}

function seed(service, id, value) {
  mkdirSync(dirname(service.taskRuntimeLeasePath(id)), { recursive: true });
  writeFileSync(service.taskRuntimeLeasePath(id), typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

test("construction is lazy and creating shared state starts no storage or timer work", () => {
  const fail = () => { throw new Error("must remain lazy"); };
  const state = createTaskLeaseState();
  new TaskLeaseService({ dataDir: fail, listTasks: fail, patchTask: fail, setHeartbeat: fail, state });
  assert.equal(state.heartbeatTimer, null);
  assert.equal(state.ownedTasks.size, 0);
  assert.equal(typeof state.token, "string");
});

test("lease records, filename mapping and ownership survive service recreation", (t) => {
  let now = Date.now();
  const f = fixture(t, { now: () => now });
  assert.equal(f.service.acquireTaskLease("bot:worker"), true);
  const first = record(f.service, "bot:worker");
  assert.deepEqual(first, { token: f.state.token, pid: process.pid, acquiredAt: now, heartbeatAt: now });
  assert.equal(f.service.taskRuntimeLeasePath("bot:worker"), join(f.root, "task-leases", "bot_worker.json"));
  now += 1_000;
  const reloaded = new TaskLeaseService({
    dataDir: () => f.root, listTasks: () => [], patchTask: () => undefined,
    state: f.state, now: () => now,
  });
  assert.equal(reloaded.acquireTaskLease("bot:worker"), true);
  assert.deepEqual(record(reloaded, "bot:worker"), { ...first, heartbeatAt: now });
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].unrefs, 1);
  assert.equal(f.service.ownsTaskLease("bot:worker"), true);
  reloaded.releaseTaskLease("bot:worker");
  assert.equal(f.service.hasActiveTaskLease("bot:worker"), false);
});

test("a single unreferenced heartbeat updates only records owned by this token", (t) => {
  let now = Date.now();
  const f = fixture(t, { now: () => now });
  f.service.acquireTaskLease("a");
  f.service.acquireTaskLease("b");
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delayMs, HEARTBEAT_MS);
  const stolen = { ...record(f.service, "b"), token: "another-owner" };
  seed(f.service, "b", stolen);
  now += HEARTBEAT_MS;
  f.timers[0].callback();
  assert.equal(record(f.service, "a").heartbeatAt, now);
  assert.deepEqual(record(f.service, "b"), stolen);
  f.service.releaseTaskLease("b");
  assert.equal(existsSync(f.service.taskRuntimeLeasePath("b")), true);
  f.service.stopHeartbeat();
  assert.equal(f.timers[0].cleared, true);
  assert.equal(f.state.heartbeatTimer, null);
  assert.equal(f.service.ownsTaskLease("a"), true);
  f.service.releaseTaskLease("a");
});

test("healthy foreign owners and fresh incomplete writes are not acquired", (t) => {
  const f = fixture(t);
  seed(f.service, "foreign", { token: "foreign", pid: process.pid, acquiredAt: Date.now(), heartbeatAt: Date.now() });
  assert.equal(f.service.acquireTaskLease("foreign"), false);
  assert.equal(f.service.hasActiveTaskLease("foreign"), true);
  assert.equal(f.service.ownsTaskLease("foreign"), false);
  f.service.releaseTaskLease("foreign");
  assert.equal(existsSync(f.service.taskRuntimeLeasePath("foreign")), true);
  seed(f.service, "partial", "");
  assert.equal(f.service.hasActiveTaskLease("partial"), true);
  assert.equal(f.service.acquireTaskLease("partial"), false);
});

test("stale incomplete records are reclaimed with the existing timeout policy", (t) => {
  let now = Date.now();
  const f = fixture(t, { now: () => now });
  seed(f.service, "partial", "{broken");
  now = statSync(f.service.taskRuntimeLeasePath("partial")).mtimeMs + TASK_LEASE_STALE_MS + 1;
  assert.equal(f.service.hasActiveTaskLease("partial"), false);
  assert.equal(f.service.acquireTaskLease("partial"), true);
  assert.equal(record(f.service, "partial").token, f.state.token);
  f.service.releaseTaskLease("partial");
});

test("reconciliation preserves working snapshots, caps replay and notifies only once", (t) => {
  const f = fixture(t);
  f.service.acquireTaskLease("live");
  f.rows.push({ id: "live", status: "working", updatedAt: "before" });
  for (let n = 0; n < 101; n += 1) f.rows.push({ id: `orphan-${n}`, status: "working", updatedAt: "before", kind: n % 2 ? "bot" : "code" });
  assert.equal(f.service.reconcileOrphanedWorkingTasks().length, 101);
  assert.equal(f.rows[0].status, "working");
  assert.equal(f.state.pendingOrphans.length, 100);
  const received = [];
  f.service.setOrphanedTaskListener((tasks) => { received.push(tasks); });
  assert.equal(received.length, 1);
  assert.equal(received[0][0].id, "orphan-1");
  assert.ok(received[0].every((task) => task.status === "working" && task.updatedAt === "before"));
  assert.ok(f.rows.slice(1).every((task) => task.status === "error" && task.error === ORPHANED_WORKING_TASK_ERROR));
  f.service.setOrphanedTaskListener((tasks) => { received.push(tasks); });
  assert.deepEqual(f.service.reconcileOrphanedWorkingTasks(), []);
  assert.equal(received.length, 1);
  f.service.setOrphanedTaskListener(() => { throw new Error("listener failure"); });
  f.rows.push({ id: "late", status: "working" });
  assert.deepEqual(f.service.reconcileOrphanedWorkingTasks(), ["late"]);
  assert.equal(f.warnings.length, 1);
  f.service.releaseTaskLease("live");
});

test("legacy states keep their token and ownership while adding orphan notification fields", (t) => {
  const legacy = { token: "legacy-owner", ownedTasks: new Set(), heartbeatTimer: null };
  const f = fixture(t, { state: legacy });
  assert.equal(legacy.token, "legacy-owner");
  assert.equal(legacy.orphanListener, null);
  assert.deepEqual(legacy.pendingOrphans, []);
  assert.equal(f.service.acquireTaskLease("legacy"), true);
  assert.equal(record(f.service, "legacy").token, "legacy-owner");
  f.service.releaseTaskLease("legacy");
});

async function waitForMessage(child) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    return await Promise.race([
      once(child, "message", { signal: controller.signal }).then(([message]) => message),
      once(child, "exit", { signal: controller.signal }).then(([code]) => { throw new Error(`lease fixture exited before its response: ${code}`); }),
    ]);
  } finally { clearTimeout(timeout); controller.abort(); }
}

async function startOwner(t, root) {
  const moduleUrl = new URL("./task-runtime-lease.mjs", import.meta.url).href;
  const code = `
    import { TaskLeaseService } from ${JSON.stringify(moduleUrl)};
    const service = new TaskLeaseService({ dataDir: () => ${JSON.stringify(root)}, listTasks: () => [], patchTask: () => undefined });
    process.on("message", (message) => {
      if (message.command === "release") {
        service.releaseTaskLease("shared");
        process.send({ released: true });
      }
    });
    process.send({ acquired: service.acquireTaskLease("shared"), pid: process.pid });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4_000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  try {
    const message = await waitForMessage(child);
    assert.equal(message.acquired, true);
    return { child, pid: message.pid };
  } catch (error) { throw new Error(`lease owner failed: ${stderr}`, { cause: error }); }
}

test("a real second Node process cannot take or remove the live owner's lease", { timeout: 7_000 }, async (t) => {
  const f = fixture(t);
  const { child, pid } = await startOwner(t, f.root);
  const owned = record(f.service, "shared");
  assert.equal(owned.pid, pid);
  assert.equal(f.service.hasActiveTaskLease("shared"), true);
  assert.equal(f.service.acquireTaskLease("shared"), false);
  f.service.releaseTaskLease("shared");
  assert.deepEqual(record(f.service, "shared"), owned);
  const released = waitForMessage(child);
  child.send({ command: "release" });
  assert.equal((await released).released, true);
  assert.equal(f.service.acquireTaskLease("shared"), true);
  assert.equal(record(f.service, "shared").pid, process.pid);
  f.service.releaseTaskLease("shared");
});

test("a dead owner's fresh record is directly reclaimable without waiting for its mtime", { timeout: 7_000 }, async (t) => {
  const f = fixture(t);
  const { child, pid } = await startOwner(t, f.root);
  const exited = once(child, "exit");
  child.kill();
  await exited;
  assert.equal(record(f.service, "shared").pid, pid);
  assert.equal(f.service.acquireTaskLease("shared"), true);
  assert.equal(record(f.service, "shared").pid, process.pid);
  f.service.releaseTaskLease("shared");
});

test("dead owner leases are reconciled and reclaimable without a Web process", { timeout: 7_000 }, async (t) => {
  const f = fixture(t);
  const { child } = await startOwner(t, f.root);
  const exited = once(child, "exit");
  child.kill();
  await exited;
  assert.equal(f.service.hasActiveTaskLease("shared"), false);
  f.rows.push({ id: "shared", status: "working", updatedAt: "before" });
  const snapshots = [];
  f.service.setOrphanedTaskListener((tasks) => { snapshots.push(...tasks); });
  assert.deepEqual(f.service.reconcileOrphanedWorkingTasks(), ["shared"]);
  assert.equal(snapshots[0].status, "working");
  assert.equal(f.rows[0].error, ORPHANED_WORKING_TASK_ERROR);
  assert.equal(existsSync(f.service.taskRuntimeLeasePath("shared")), false);
  assert.equal(f.service.acquireTaskLease("shared"), true);
  f.service.releaseTaskLease("shared");
});
