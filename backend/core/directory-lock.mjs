import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** A live owner pid is trusted only this long past `staleMs` (guards against pid reuse). */
const LIVE_OWNER_HARD_CAP_MS = 10 * 60_000;

function blockingSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const newOwner = () => `${process.pid}:${randomUUID()}`;
export const ownerFile = (lockPath) => join(lockPath, "owner");

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

/**
 * Whether a lock whose directory is `ageMs` old and whose owner token is `owner`
 * (null when unreadable/legacy) may be reclaimed. Time alone never steals a lock
 * held by a live process until the hard cap.
 */
export function reclaimable(ageMs, owner, staleMs) {
  if (!(ageMs > staleMs)) return false;
  const pid = Number(String(owner ?? "").split(":")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (!pidAlive(pid)) return true;
  return ageMs > Math.max(staleMs, LIVE_OWNER_HARD_CAP_MS);
}

export function readOwnerSync(lockPath) {
  try { return readFileSync(ownerFile(lockPath), "utf8"); } catch { return null; }
}
async function readOwner(lockPath) {
  try { return await readFile(ownerFile(lockPath), "utf8"); } catch { return null; }
}

/** Remove the lock only while it still carries our token, so a reclaimed lock is never deleted by its former owner. */
function releaseSync(lockPath, owner) {
  if (readOwnerSync(lockPath) === owner) rmSync(lockPath, { recursive: true, force: true });
}
async function release(lockPath, owner) {
  if ((await readOwner(lockPath)) === owner) await rm(lockPath, { recursive: true, force: true });
}

/**
 * Run `action` while holding an atomically created lock directory shared by
 * every worker. Blocks synchronously (the guarded read/check/write sequences are
 * synchronous): up to `maxAttempts` tries `waitMs` apart, then throws
 * `busyMessage`. The lock directory carries an `owner` token (`pid:uuid`). A lock
 * older than `staleMs` is removed only when its owner process is gone (or the
 * token is missing, or the hard cap passed) and the token is unchanged at removal
 * time; losing that race to another worker just means retrying. Release only
 * deletes the lock while it still carries this call's token, including when
 * `action` throws.
 */
export function withDirectoryLock({
  lockPath, parentDir, staleMs, busyMessage,
  maxAttempts = 300, waitMs = 10, now = () => Date.now(), sleep = blockingSleep,
}, action) {
  mkdirSync(parentDir, { recursive: true });
  const owner = newOwner();
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(lockPath);
      try { writeFileSync(ownerFile(lockPath), owner, "utf8"); }
      catch (error) { rmSync(lockPath, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        // Lock directory vanished or is otherwise unavailable: retry; real failures surface via busyMessage.
        if (attempt >= maxAttempts) throw new Error(busyMessage);
        sleep(waitMs);
        continue;
      }
      try {
        const seen = readOwnerSync(lockPath);
        if (reclaimable(now() - statSync(lockPath).mtimeMs, seen, staleMs) && readOwnerSync(lockPath) === seen) {
          rmSync(lockPath, { recursive: true, force: true });
        }
      } catch { /* another worker removed or replaced the lock */ }
      if (attempt >= maxAttempts) throw new Error(busyMessage);
      sleep(waitMs);
    }
  }
  try { return action(); } finally { releaseSync(lockPath, owner); }
}

/**
 * Run an async action under the same cross-process directory lock without blocking while waiting.
 * Lock acquisition is atomic; stale locks are reclaimed using the same policy as withDirectoryLock.
 */
export async function withDirectoryLockAsync({
  lockPath, parentDir, staleMs, busyMessage,
  maxAttempts = 300, waitMs = 10, now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}, action) {
  await mkdir(parentDir, { recursive: true });
  const owner = newOwner();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lockPath);
      try { await writeFile(ownerFile(lockPath), owner, "utf8"); }
      catch (error) { await rm(lockPath, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (attempt >= maxAttempts) throw new Error(busyMessage);
        await sleep(waitMs);
        continue;
      }
      try {
        const seen = await readOwner(lockPath);
        if (reclaimable(now() - (await stat(lockPath)).mtimeMs, seen, staleMs) && (await readOwner(lockPath)) === seen) {
          await rm(lockPath, { recursive: true, force: true });
        }
      } catch { /* another worker removed or replaced the lock */ }
      if (attempt >= maxAttempts) throw new Error(busyMessage);
      await sleep(waitMs);
    }
  }
  try { return await action(); } finally { await release(lockPath, owner); }
}
