import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { listTasks, patchTask } from "@/lib/store";

type TaskLeaseRecord = { token: string; pid: number; acquiredAt: number; heartbeatAt: number };

const TASK_LEASE_STALE_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const MAX_ACQUIRE_ATTEMPTS = 4;
// Match the harness runtime lifetime across Next route bundles and hot reloads.
const globalRef = globalThis as typeof globalThis & {
  __leafcodeTaskLeaseState?: {
    token: string;
    ownedTasks: Set<string>;
    heartbeatTimer: ReturnType<typeof setInterval> | null;
  };
};
const leaseState = globalRef.__leafcodeTaskLeaseState ??= {
  token: randomUUID(),
  ownedTasks: new Set<string>(),
  heartbeatTimer: null,
};
const PROCESS_TOKEN = leaseState.token;
const ownedTasks = leaseState.ownedTasks;

function leasePath(taskId: string): string {
  const safeId = taskId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dataDir(), "task-leases", `${safeId}.json`);
}

function readLease(path: string): TaskLeaseRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TaskLeaseRecord>;
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "number" || typeof parsed.heartbeatAt !== "number") return null;
    return parsed as TaskLeaseRecord;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EPERM");
  }
}

function leaseActive(record: TaskLeaseRecord | null, now = Date.now()): boolean {
  return Boolean(record && processAlive(record.pid) && now - record.heartbeatAt <= TASK_LEASE_STALE_MS);
}

function ensureHeartbeat(): void {
  if (leaseState.heartbeatTimer) return;
  leaseState.heartbeatTimer = setInterval(() => {
    for (const taskId of ownedTasks) touchTaskLease(taskId);
  }, HEARTBEAT_MS);
  leaseState.heartbeatTimer.unref?.();
}

function touchTaskLease(taskId: string): void {
  const path = leasePath(taskId);
  const record = readLease(path);
  if (!record || record.token !== PROCESS_TOKEN) return;
  try {
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...record, heartbeatAt: Date.now() })}\n`, "utf8");
    renameSync(temporary, path);
  } catch { /* cleanup/reconcile will handle a transient write failure */ }
}

/** Claim a task's runtime lease before persisting status=working. */
export function acquireTaskLease(taskId: string): boolean {
  mkdirSync(join(dataDir(), "task-leases"), { recursive: true });
  const path = leasePath(taskId);
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const now = Date.now();
    const existing = readLease(path);
    if (existing?.token === PROCESS_TOKEN) {
      ownedTasks.add(taskId);
      touchTaskLease(taskId);
      ensureHeartbeat();
      return true;
    }
    if (leaseActive(existing, now)) return false;
    // Reclaim an abandoned record before trying O_EXCL. Keep this loop
    // bounded: another worker may win the race between unlink and open.
    let stalePath = Boolean(existing && !processAlive(existing.pid));
    if (!stalePath) {
      try { stalePath = now - statSync(path).mtimeMs > TASK_LEASE_STALE_MS; }
      catch { /* no lease file */ }
    }
    if (stalePath) {
      try { unlinkSync(path); } catch { /* another worker reclaimed it */ }
    }
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify({ token: PROCESS_TOKEN, pid: process.pid, acquiredAt: now, heartbeatAt: now })}\n`, "utf8");
      } finally { closeSync(fd); }
      ownedTasks.add(taskId);
      ensureHeartbeat();
      return true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code !== "EEXIST") throw error;
      // Re-read on the next bounded attempt rather than recursing forever.
    }
  }
  return false;
}

export function releaseTaskLease(taskId: string): void {
  ownedTasks.delete(taskId);
  const path = leasePath(taskId);
  try {
    if (readLease(path)?.token === PROCESS_TOKEN) unlinkSync(path);
  } catch { /* best effort */ }
}

export function hasActiveTaskLease(taskId: string): boolean {
  const path = leasePath(taskId);
  const record = readLease(path);
  if (record?.token === PROCESS_TOKEN) return ownedTasks.has(taskId);
  if (record) return leaseActive(record);
  // A just-created lease can be observed between O_EXCL and its payload write.
  // Treat that short window as owned; stale cleanup handles a crashed writer.
  try { return Date.now() - statSync(path).mtimeMs <= TASK_LEASE_STALE_MS; } catch { return false; }
}

export function taskRuntimeLeasePath(taskId: string): string {
  return leasePath(taskId);
}

export const ORPHANED_WORKING_TASK_ERROR = "ホスト再起動後にCodeセッションを復旧できなかったため停止しました";

/** Mark persisted working tasks with no live worker lease as failed, never resume them. */
export function reconcileOrphanedWorkingTasks(): string[] {
  const reconciled: string[] = [];
  // listTasks defaults to Code tasks; Bot 1:1 and room tasks also persist
  // status=working and must be stopped after a worker restart.
  const tasks = [...listTasks(true), ...listTasks(true, "bot")];
  for (const task of tasks) {
    if (task.status !== "working" || hasActiveTaskLease(task.id)) continue;
    const updated = patchTask(task.id, { status: "error", error: ORPHANED_WORKING_TASK_ERROR });
    if (updated?.status === "error" && updated.error === ORPHANED_WORKING_TASK_ERROR) {
      reconciled.push(task.id);
    }
    try { unlinkSync(leasePath(task.id)); } catch { /* already absent */ }
  }
  return reconciled;
}