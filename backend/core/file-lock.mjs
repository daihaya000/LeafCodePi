import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const MAX_LIVE_OWNER_AGE_MS = 10 * 60_000;

function abandoned(lock) {
  try {
    const ageMs = Date.now() - statSync(lock).mtimeMs;
    // PID reuse can make a dead owner's lock appear live indefinitely. Bound the wait
    // without adding an OS-specific process-start-time lookup to this hot path.
    if (ageMs > MAX_LIVE_OWNER_AGE_MS) return true;
    const pid = Number(readFileSync(join(lock, "owner"), "utf8").split(":")[0]);
    if (!Number.isInteger(pid) || pid <= 0) return ageMs > 30_000;
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === "ESRCH"; }
  } catch {
    // A creator may not have written its owner yet. Never steal a fresh lock.
    try { return Date.now() - statSync(lock).mtimeMs > 30_000; } catch { return false; }
  }
}

/**
 * SQLite's OS lock serializes *all* acquisitions, including stale-lock reclamation.
 * Never unlink this sidecar: its stable identity is what makes takeover atomic.
 * JSON v1 remains the only source of application data; no records go into SQLite.
 */
export function withFileLock(file, update, { timeoutMs = 5_000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("invalid lock timeout");
  mkdirSync(dirname(file), { recursive: true });
  const startedAt = Date.now();
  const mutex = new DatabaseSync(`${file}.lock.sqlite`);
  try {
    mutex.exec(`PRAGMA busy_timeout=${Math.floor(timeoutMs)}`);
    try { mutex.exec("BEGIN IMMEDIATE"); }
    catch (error) {
      if (error.errcode === 5 || error.errcode === 6) throw new Error("shared file lock timeout", { cause: error });
      throw error;
    }
    return withDirectoryLock(file, update, { timeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAt)) });
  } finally {
    // Closing rolls back the empty transaction and releases the kernel-managed lock.
    mutex.close();
  }
}

function withDirectoryLock(file, update, { timeoutMs }) {
  const lock = `${file}.lock`;
  const reclaim = `${lock}.reclaim`;
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(file), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      try { writeFileSync(join(lock, "owner"), owner, "utf8"); }
      catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (abandoned(lock)) {
        let acquired = false;
        try {
          mkdirSync(reclaim);
          acquired = true;
          writeFileSync(join(reclaim, "owner"), owner, "utf8");
          if (abandoned(lock)) rmSync(lock, { recursive: true, force: true });
        } catch (reclaimError) {
          if (reclaimError.code !== "EEXIST") throw reclaimError;
          if (abandoned(reclaim)) rmSync(reclaim, { recursive: true, force: true });
        } finally {
          if (acquired) rmSync(reclaim, { recursive: true, force: true });
        }
      }
      if (Date.now() >= deadline) throw new Error("shared file lock timeout");
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try { return update(); }
  finally {
    if (readFileSync(join(lock, "owner"), "utf8") === owner) rmSync(lock, { recursive: true, force: true });
  }
}
