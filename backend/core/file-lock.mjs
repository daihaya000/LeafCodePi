import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function abandoned(lock) {
  try {
    const pid = Number(readFileSync(join(lock, "owner"), "utf8").split(":")[0]);
    if (!Number.isInteger(pid) || pid <= 0) return Date.now() - statSync(lock).mtimeMs > 30_000;
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === "ESRCH"; }
  } catch {
    // A creator may not have written its owner yet. Never steal a fresh lock.
    try { return Date.now() - statSync(lock).mtimeMs > 30_000; } catch { return false; }
  }
}

/** Synchronous cross-process read/modify/write lock; live owners never expire. */
export function withFileLock(file, update, { timeoutMs = 5_000 } = {}) {
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
