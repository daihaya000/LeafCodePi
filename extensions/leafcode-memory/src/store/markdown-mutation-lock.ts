import * as path from "node:path";
import { AtomicLockCoordinator, type AtomicLockLease } from "./atomic-lock-coordinator.js";
import { canonicalStoragePath } from "./canonical-storage-path.js";
import { LOCK_DATABASE_FILE } from "../constants.js";

const MUTATION_WAIT_MS = 5_000;
// Heartbeat keeps a healthy long mutation alive; peers reclaim wedged holders
// after this window instead of waiting five minutes (#144 pattern).
const MUTATION_STALE_MS = 45_000;
const MUTATION_HEARTBEAT_MS = 10_000;

export async function canonicalMarkdownIdentity(filePath: string): Promise<string> {
  return canonicalStoragePath(filePath);
}

export async function acquireMarkdownMutationLock(filePath: string): Promise<AtomicLockLease> {
  const identity = await canonicalMarkdownIdentity(filePath);
  const coordinatorDir = path.dirname(path.dirname(identity));
  const coordinator = AtomicLockCoordinator.shared(path.join(coordinatorDir, LOCK_DATABASE_FILE));
  const lockKey = `mutation:${identity}`;
  const deadline = Date.now() + MUTATION_WAIT_MS;
  let lease = coordinator.tryAcquire(lockKey, { staleMs: MUTATION_STALE_MS });

  while (!lease) {
    if (Date.now() >= deadline) {
      throw new Error(`Memory mutation already in progress for ${identity}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    lease = coordinator.tryAcquire(lockKey, { staleMs: MUTATION_STALE_MS });
  }

  return lease;
}

export async function withMarkdownMutationLock<T>(filePath: string, operation: () => Promise<T> | T): Promise<T> {
  const lease = await acquireMarkdownMutationLock(filePath);
  const heartbeat = setInterval(() => {
    try {
      lease.renew();
    } catch {
      // A missed beat only moves the lease closer to staleMs.
    }
  }, MUTATION_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const result = await operation();
    // Abort publishing success if another session stole the lease mid-write.
    if (!lease.renew()) {
      throw new Error(`Lost markdown mutation lock for ${filePath}`);
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    lease.release();
  }
}
