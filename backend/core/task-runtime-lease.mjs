import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { processStartKey } from "../../shared/process-identity.mjs";

export const TASK_LEASE_STALE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;
const MAX_ACQUIRE_ATTEMPTS = 4;
/** 3 missed heartbeats (45s) is still inside TASK_LEASE_STALE_MS, so the loss is reported before takeover. */
const MAX_HEARTBEAT_FAILURES = 3;
/** Reclaim locks only bridge a read-check-delete, so a long-lived one means its holder crashed. */
export const RECLAIM_LOCK_STALE_MS = 10_000;
const MAX_PENDING_ORPHANS = 100;
export const ORPHANED_WORKING_TASK_ERROR = "ホスト再起動後にCodeセッションを復旧できなかったため停止しました";

/** Caller-owned state can outlive module reloads without creating another owner. */
export function createTaskLeaseState() {
  return {
    token: randomUUID(),
    ownedTasks: new Set(),
    heartbeatTimer: null,
    orphanListener: null,
    pendingOrphans: [],
    leaseLostListener: null,
    pendingLeaseLosses: [],
    pendingLeaseLossIds: new Set(),
  };
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
    getProcessStartKey = processStartKey,
    setHeartbeat = (callback, delayMs) => setInterval(callback, delayMs),
    clearHeartbeat = (timer) => clearInterval(timer),
    warn = (message, error) => console.warn(message, error),
    renameFile = renameSync,
    renameDirectory = renameSync,
    linkFile = linkSync,
  }) {
    this.dataDir = dataDir;
    this.listTasks = listTasks;
    this.patchTask = patchTask;
    this.state = state;
    this.token = state.token;
    this.pid = pid;
    this.now = now;
    this.isProcessAlive = isProcessAlive;
    this.getProcessStartKey = getProcessStartKey;
    this.reclaimOwnerStartKeyRead = false;
    this.reclaimOwnerStartKey = null;
    this.setHeartbeat = setHeartbeat;
    this.clearHeartbeat = clearHeartbeat;
    this.warn = warn;
    this.renameFile = renameFile;
    this.renameDirectory = renameDirectory;
    this.linkFile = linkFile;
    // Older hot-reloaded states predate notification fields.
    state.orphanListener ??= null;
    state.pendingOrphans ??= [];
    state.leaseLostListener ??= null;
    state.pendingLeaseLosses ??= [];
    state.pendingLeaseLossIds ??= new Set(state.pendingLeaseLosses);
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
    if (!record || record.token !== this.token) {
      this.#loseTaskLease(taskId);
      return;
    }
    try {
      const temporary = `${path}.${this.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ ...record, heartbeatAt: this.now() })}\n`, "utf8");
      try { this.renameFile(temporary, path); }
      catch (error) { try { unlinkSync(temporary); } catch { /* temp may be gone */ } throw error; }
      this.#heartbeatFailures.delete(taskId);
    } catch (error) {
      // A transient failure is tolerated, but a lease that cannot be refreshed turns stale after
      // TASK_LEASE_STALE_MS and another worker would take the task while this process keeps
      // running it. Report the loss before that happens so the caller stops the prompt.
      const failures = (this.#heartbeatFailures.get(taskId) ?? 0) + 1;
      this.#heartbeatFailures.set(taskId, failures);
      this.warn(`[task-runtime-lease] heartbeat write failed (${failures}/${MAX_HEARTBEAT_FAILURES})`, error);
      if (failures >= MAX_HEARTBEAT_FAILURES) this.#loseTaskLease(taskId);
    }
  }

  /** Consecutive failed heartbeat writes per owned task. */
  #heartbeatFailures = new Map();

  #loseTaskLease(taskId) {
    this.#heartbeatFailures.delete(taskId);
    if (!this.state.ownedTasks.delete(taskId)) return;
    const listener = this.state.leaseLostListener;
    if (listener) {
      this.#notifyLeaseLoss(listener, [taskId]);
      return;
    }
    const losses = this.state.pendingLeaseLosses ??= [];
    const lossIds = this.state.pendingLeaseLossIds ??= new Set(losses);
    if (!lossIds.has(taskId)) {
      lossIds.add(taskId);
      losses.push(taskId);
    }
  }

  #isStalePath(path, existing, now) {
    if (existing && !this.isProcessAlive(existing.pid)) return true;
    try { return now - statSync(path).mtimeMs > TASK_LEASE_STALE_MS; }
    catch { return false; /* no lease file */ }
  }

  /**
   * Delete a stale lease while holding the per-task reclaim lock, re-validating
   * under the lock. Returns true when the path is free to create (removed or
   * already gone); false when it is live again or another worker is reclaiming.
   */
  #reclaimStale(path) {
    const lock = `${path}.reclaim`;
    const token = this.#takeReclaimLock(lock);
    if (!token) return false;
    try {
      const now = this.now();
      const current = this.#readLease(path);
      if (this.#leaseActive(current, now)) return false;
      let exists = true;
      try { statSync(path); } catch { exists = false; }
      if (!exists) return true;
      if (!this.#isStalePath(path, current, now)) return false;
      try { unlinkSync(path); } catch { /* already removed */ }
      return true;
    } finally {
      // Only remove the lock while it still carries our token: if it outlived its stale limit
      // and another worker took it over, deleting it would reopen the race it guards.
      try { if (this.#readReclaimOwner(lock) === token) rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  #readReclaimOwner(lock) {
    try { return readFileSync(join(lock, "owner"), "utf8"); } catch { return null; }
  }

  /**
   * The owner record is written in a temporary directory and renamed into place so a crash cannot
   * leave an ownerless lock while a live process is still creating it. An old lock is reclaimed
   * only after its PID is gone or its process-start key proves that the PID was reused; unknown
   * identity fails closed. Returns the serialized owner token, or null when not acquired.
   */
  #takeReclaimLock(lock) {
    const readOwnStartKey = () => {
      if (!this.reclaimOwnerStartKeyRead) {
        try {
          const startKey = this.getProcessStartKey(this.pid);
          if (typeof startKey === "string" && startKey) {
            this.reclaimOwnerStartKey = startKey;
            this.reclaimOwnerStartKeyRead = true;
          }
        } catch { /* retry later; unknown identity is never treated as dead */ }
      }
      return this.reclaimOwnerStartKeyRead ? this.reclaimOwnerStartKey : null;
    };
    const create = () => {
      const ownStartKey = readOwnStartKey();
      if (!ownStartKey) {
        try { statSync(lock); }
        catch { return null; }
        const occupied = new Error("reclaim lock already exists");
        occupied.code = "EEXIST";
        throw occupied;
      }
      const ownerToken = JSON.stringify({
        pid: this.pid,
        processStartKey: ownStartKey,
        token: randomUUID(),
      });
      const temporary = `${lock}.${this.pid}.${randomUUID()}.tmp`;
      mkdirSync(temporary);
      try {
        writeFileSync(join(temporary, "owner"), ownerToken, "utf8");
        try {
          statSync(lock);
          const occupied = new Error("reclaim lock already exists");
          occupied.code = "EEXIST";
          throw occupied;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        try { this.renameDirectory(temporary, lock); }
        catch (error) {
          let lockExists = false;
          try { statSync(lock); lockExists = true; } catch { /* no competing lock */ }
          if (lockExists) {
            const occupied = new Error("reclaim lock already exists");
            occupied.code = "EEXIST";
            throw occupied;
          }
          throw error;
        }
        return ownerToken;
      } finally {
        try { rmSync(temporary, { recursive: true, force: true }); } catch { /* renamed or already gone */ }
      }
    };
    try { return create(); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    try {
      if (this.now() - statSync(lock).mtimeMs <= RECLAIM_LOCK_STALE_MS) return null;
      const seen = this.#readReclaimOwner(lock);
      if (!seen) return null;
      let owner;
      try { owner = JSON.parse(seen); } catch { /* accept legacy PID:token records below */ }
      if (owner && typeof owner === "object" && !Array.isArray(owner)) {
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string" || !owner.token) return null;
      } else {
        const pid = Number(seen.split(":")[0]);
        owner = Number.isSafeInteger(pid) && pid > 0 ? { pid, processStartKey: null } : null;
      }
      if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;

      let ownerGone = !this.isProcessAlive(owner.pid);
      if (!ownerGone && typeof owner.processStartKey === "string" && owner.processStartKey) {
        let currentStartKey;
        try { currentStartKey = this.getProcessStartKey(owner.pid); } catch { /* unknown is not dead */ }
        if (typeof currentStartKey === "string" && currentStartKey && currentStartKey !== owner.processStartKey) ownerGone = true;
      }
      if (!ownerGone || this.#readReclaimOwner(lock) !== seen || !this.reclaimOwnerStartKeyRead) return null;
      rmSync(lock, { recursive: true, force: true });
      return create();
    } catch { return null; }
  }

  /**
   * Publish a fully written lease with an atomic, exclusive hard link. If the filesystem
   * cannot provide that primitive, fail before exposing the target path; O_EXCL plus a later
   * write can leave a fresh empty lease behind if the process exits between those syscalls.
   */
  #createLeaseFile(path, payload) {
    const temporary = `${path}.${this.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, payload, "utf8");
    try {
      this.linkFile(temporary, path);
    } catch (error) {
      if (error?.code === "EEXIST") throw error;
      throw new Error("Atomic task lease publication failed; refusing a non-atomic fallback", { cause: error });
    } finally {
      try { unlinkSync(temporary); } catch { /* temp may be gone */ }
    }
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
      // Removing a stale record is serialized per task: two workers that both judged it
      // stale must not each delete the other's freshly created lease. Acquisition itself
      // stays the bounded O_EXCL create below, so exactly one creator wins.
      if (this.#isStalePath(path, existing, now) && !this.#reclaimStale(path)) continue;
      try {
        this.#createLeaseFile(path, `${JSON.stringify({ token: this.token, pid: this.pid, acquiredAt: now, heartbeatAt: now })}\n`);
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
    this.#heartbeatFailures.delete(taskId);
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

  setLeaseLostListener(listener) {
    this.state.leaseLostListener = listener;
    if (!listener) return;
    const pending = this.state.pendingLeaseLosses ?? [];
    this.state.pendingLeaseLosses = [];
    this.state.pendingLeaseLossIds?.clear();
    if (pending.length > 0) this.#notifyLeaseLoss(listener, pending);
  }

  #notifyLeaseLoss(listener, taskIds) {
    try { listener(taskIds); }
    catch (error) { this.warn("[task-runtime-lease] lease-lost listener failed", error); }
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
      const updated = this.patchTask(task.id, {
        status: "error",
        error: ORPHANED_WORKING_TASK_ERROR,
        orphanedSourceUpdatedAt: task.updatedAt,
      });
      if (updated?.status === "error" && updated.error === ORPHANED_WORKING_TASK_ERROR) {
        reconciled.push(task.id);
        snapshots.push(snapshot);
      }
      try { unlinkSync(this.taskRuntimeLeasePath(task.id)); } catch { /* already absent */ }
    }
    if (snapshots.length > 0) {
      const listener = this.state.orphanListener;
      if (listener) this.#notifyOrphans(listener, snapshots);
      else {
        const pending = [...(this.state.pendingOrphans ?? []), ...snapshots];
        if (pending.length > MAX_PENDING_ORPHANS) {
          // Not silent: these tasks are already marked error on disk but will not be offered for automatic resume.
          this.warn(`[task-runtime-lease] ${pending.length - MAX_PENDING_ORPHANS} oldest orphaned-task notifications dropped (cap ${MAX_PENDING_ORPHANS}); they stay in error and are not auto-resumed`, pending.slice(0, pending.length - MAX_PENDING_ORPHANS).map((task) => task.id));
        }
        this.state.pendingOrphans = pending.slice(-MAX_PENDING_ORPHANS);
      }
    }
    return reconciled;
  }

  /** Stops scheduled writes only; caller still owns execution and lease release. */
  stopHeartbeat() {
    if (this.state.heartbeatTimer) this.clearHeartbeat(this.state.heartbeatTimer);
    this.state.heartbeatTimer = null;
  }
}
