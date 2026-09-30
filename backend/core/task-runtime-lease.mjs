import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const TASK_LEASE_STALE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;
const MAX_ACQUIRE_ATTEMPTS = 4;
const MAX_PENDING_ORPHANS = 100;
export const ORPHANED_WORKING_TASK_ERROR = "ホスト再起動後にCodeセッションを復旧できなかったため停止しました";

/** Caller-owned state can outlive module reloads without creating another owner. */
export function createTaskLeaseState() {
  return { token: randomUUID(), ownedTasks: new Set(), heartbeatTimer: null, orphanListener: null, pendingOrphans: [] };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

/** Storage/store/timers remain lazy; importing this module does not start work. */
export class TaskLeaseService {
  constructor({
    dataDir, listTasks, patchTask, state = createTaskLeaseState(),
    pid = process.pid, now = () => Date.now(), isProcessAlive = processAlive,
    setHeartbeat = (callback, delayMs) => setInterval(callback, delayMs),
    clearHeartbeat = (timer) => clearInterval(timer),
    warn = (message, error) => console.warn(message, error),
  }) {
    this.dataDir = dataDir;
    this.listTasks = listTasks;
    this.patchTask = patchTask;
    this.state = state;
    this.token = state.token;
    this.pid = pid;
    this.now = now;
    this.isProcessAlive = isProcessAlive;
    this.setHeartbeat = setHeartbeat;
    this.clearHeartbeat = clearHeartbeat;
    this.warn = warn;
    // Older hot-reloaded states predate orphan notification fields.
    state.orphanListener ??= null;
    state.pendingOrphans ??= [];
  }

  taskRuntimeLeasePath(taskId) {
    const safeId = taskId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(this.dataDir(), "task-leases", `${safeId}.json`);
  }

  #readLease(path) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed.token !== "string" || typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "number" || typeof parsed.heartbeatAt !== "number") return null;
      return parsed;
    } catch { return null; }
  }

  #leaseActive(record, now = this.now()) {
    return Boolean(record && this.isProcessAlive(record.pid) && now - record.heartbeatAt <= TASK_LEASE_STALE_MS);
  }

  #ensureHeartbeat() {
    if (this.state.heartbeatTimer) return;
    this.state.heartbeatTimer = this.setHeartbeat(() => {
      for (const taskId of this.state.ownedTasks) this.#touchTaskLease(taskId);
    }, HEARTBEAT_MS);
    this.state.heartbeatTimer.unref?.();
  }

  #touchTaskLease(taskId) {
    const path = this.taskRuntimeLeasePath(taskId);
    const record = this.#readLease(path);
    if (!record || record.token !== this.token) return;
    try {
      const temporary = `${path}.${this.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ ...record, heartbeatAt: this.now() })}\n`, "utf8");
      renameSync(temporary, path);
    } catch { /* cleanup/reconcile handles a transient write failure */ }
  }

  acquireTaskLease(taskId) {
    mkdirSync(join(this.dataDir(), "task-leases"), { recursive: true });
    const path = this.taskRuntimeLeasePath(taskId);
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const now = this.now();
      const existing = this.#readLease(path);
      if (existing?.token === this.token) {
        this.state.ownedTasks.add(taskId);
        this.#touchTaskLease(taskId);
        this.#ensureHeartbeat();
        return true;
      }
      if (this.#leaseActive(existing, now)) return false;
      // Preserve the existing bounded O_EXCL acquisition and stale-file policy.
      let stalePath = Boolean(existing && !this.isProcessAlive(existing.pid));
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
          writeFileSync(fd, `${JSON.stringify({ token: this.token, pid: this.pid, acquiredAt: now, heartbeatAt: now })}\n`, "utf8");
        } finally { closeSync(fd); }
        this.state.ownedTasks.add(taskId);
        this.#ensureHeartbeat();
        return true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    return false;
  }

  releaseTaskLease(taskId) {
    this.state.ownedTasks.delete(taskId);
    const path = this.taskRuntimeLeasePath(taskId);
    try {
      if (this.#readLease(path)?.token === this.token) unlinkSync(path);
    } catch { /* best effort */ }
  }

  ownsTaskLease(taskId) {
    const record = this.#readLease(this.taskRuntimeLeasePath(taskId));
    return Boolean(record?.token === this.token && this.state.ownedTasks.has(taskId));
  }

  hasActiveTaskLease(taskId) {
    const path = this.taskRuntimeLeasePath(taskId);
    const record = this.#readLease(path);
    if (record?.token === this.token) return this.ownsTaskLease(taskId);
    if (record) return this.#leaseActive(record);
    // A writer can be observed between O_EXCL creation and its payload write.
    try { return this.now() - statSync(path).mtimeMs <= TASK_LEASE_STALE_MS; }
    catch { return false; }
  }

  setOrphanedTaskListener(listener) {
    this.state.orphanListener = listener;
    if (!listener) return;
    const pending = this.state.pendingOrphans ?? [];
    this.state.pendingOrphans = [];
    if (pending.length > 0) this.#notifyOrphans(listener, pending);
  }

  #notifyOrphans(listener, tasks) {
    try { listener(tasks); }
    catch (error) { this.warn("[task-runtime-lease] orphan listener failed", error); }
  }

  reconcileOrphanedWorkingTasks() {
    const reconciled = [];
    const snapshots = [];
    for (const task of this.listTasks()) {
      if (task.status !== "working" || this.hasActiveTaskLease(task.id)) continue;
      // Store adapters may mutate a cached row during patchTask.
      const snapshot = { ...task };
      const updated = this.patchTask(task.id, { status: "error", error: ORPHANED_WORKING_TASK_ERROR });
      if (updated?.status === "error" && updated.error === ORPHANED_WORKING_TASK_ERROR) {
        reconciled.push(task.id);
        snapshots.push(snapshot);
      }
      try { unlinkSync(this.taskRuntimeLeasePath(task.id)); } catch { /* already absent */ }
    }
    if (snapshots.length > 0) {
      const listener = this.state.orphanListener;
      if (listener) this.#notifyOrphans(listener, snapshots);
      else this.state.pendingOrphans = [...(this.state.pendingOrphans ?? []), ...snapshots].slice(-MAX_PENDING_ORPHANS);
    }
    return reconciled;
  }

  /** Stops scheduled writes only; caller still owns execution and lease release. */
  stopHeartbeat() {
    if (this.state.heartbeatTimer) this.clearHeartbeat(this.state.heartbeatTimer);
    this.state.heartbeatTimer = null;
  }
}
