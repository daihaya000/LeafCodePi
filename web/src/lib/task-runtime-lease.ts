import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { listTasks, patchTask } from "@/lib/store";

type TaskLeaseRecord = { token: string; pid: number; acquiredAt: number; heartbeatAt: number };

const TASK_LEASE_STALE_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const PROCESS_TOKEN = randomUUID();
const ownedTasks = new Set<string>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const taskId of ownedTasks) touchTaskLease(taskId);
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

function touchTaskLease(taskId: string): void {
  const path = leasePath(taskId);
  const record = readLease(path);
  if (!record || record.token !== PROCESS_TOKEN) return;
  try {
    writeFileSync(path, `${JSON.stringify({ ...record, heartbeatAt: Date.now() })}\n`, "utf8");
  } catch { /* cleanup/reconcile will handle a transient write failure */ }
}

/** Claim a task's runtime lease before persisting status=working. */
export function acquireTaskLease(taskId: string): boolean {
  mkdirSync(join(dataDir(), "task-leases"), { recursive: true });
  const path = leasePath(taskId);
  const now = Date.now();
  const existing = readLease(path);
  if (existing?.token === PROCESS_TOKEN) {
    ownedTasks.add(taskId);
    touchTaskLease(taskId);
    ensureHeartbeat();
    return true;
  }
  if (leaseActive(existing, now)) return false;
  try {
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, `${JSON.stringify({ token: PROCESS_TOKEN, pid: process.pid, acquiredAt: now, heartbeatAt: now })}\n`, "utf8");
    } finally { closeSync(fd); }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "EEXIST") return acquireTaskLease(taskId);
    throw error;
  }
  ownedTasks.add(taskId);
  ensureHeartbeat();
  return true;
}

export function releaseTaskLease(taskId: string): void {
  ownedTasks.delete(taskId);
  const path = leasePath(taskId);
  try {
    if (readLease(path)?.token === PROCESS_TOKEN) unlinkSync(path);
  } catch { /* best effort */ }
}

export function hasActiveTaskLease(taskId: string): boolean {
  const record = readLease(leasePath(taskId));
  if (record?.token === PROCESS_TOKEN) return ownedTasks.has(taskId);
  return leaseActive(record);
}

export function taskRuntimeLeasePath(taskId: string): string {
  return leasePath(taskId);
}

export const ORPHANED_WORKING_TASK_ERROR = "ホスト再起動後にCodeセッションを復旧できなかったため停止しました";

/** Mark persisted working tasks with no live worker lease as failed, never resume them. */
export function reconcileOrphanedWorkingTasks(): string[] {
  const reconciled: string[] = [];
  for (const task of listTasks(true)) {
    if (task.status !== "working" || hasActiveTaskLease(task.id)) continue;
    const updated = patchTask(task.id, { status: "error", error: ORPHANED_WORKING_TASK_ERROR });
    if (updated?.status === "error" && updated.error === ORPHANED_WORKING_TASK_ERROR) {
      reconciled.push(task.id);
    }
    try { unlinkSync(leasePath(task.id)); } catch { /* already absent */ }
  }
  return reconciled;
}