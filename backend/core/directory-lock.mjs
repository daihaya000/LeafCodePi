import { mkdirSync, rmSync, statSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";

function blockingSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `action` while holding an atomically created lock directory shared by
 * every worker. Blocks synchronously (the guarded read/check/write sequences are
 * synchronous): up to `maxAttempts` tries `waitMs` apart, then throws
 * `busyMessage`. A lock older than `staleMs` belonged to a crashed worker and is
 * removed; losing that race to another worker just means retrying. The lock is
 * always released, including when `action` throws.
 */
export function withDirectoryLock({
  lockPath, parentDir, staleMs, busyMessage,
  maxAttempts = 300, waitMs = 10, now = () => Date.now(), sleep = blockingSleep,
}, action) {
  mkdirSync(parentDir, { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(lockPath);
      break;
    } catch {
      try {
        if (now() - statSync(lockPath).mtimeMs > staleMs) rmSync(lockPath, { recursive: true, force: true });
      } catch { /* another worker removed or replaced the lock */ }
      if (attempt >= maxAttempts) throw new Error(busyMessage);
      sleep(waitMs);
    }
  }
  try { return action(); } finally { rmSync(lockPath, { recursive: true, force: true }); }
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
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lockPath);
      break;
    } catch {
      try {
        if (now() - (await stat(lockPath)).mtimeMs > staleMs) await rm(lockPath, { recursive: true, force: true });
      } catch { /* another worker removed or replaced the lock */ }
      if (attempt >= maxAttempts) throw new Error(busyMessage);
      await sleep(waitMs);
    }
  }
  try { return await action(); } finally { await rm(lockPath, { recursive: true, force: true }); }
}
