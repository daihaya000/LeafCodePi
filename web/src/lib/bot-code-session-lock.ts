import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";

type LockRecord = { token: string; pid: number; acquiredAt: number };

export type BotCodeSessionLockOptions = {
  retryMs?: number;
  timeoutMs?: number;
  staleMs?: number;
};

const DEFAULT_RETRY_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 60_000;

function lockPath(botId: string): string {
  // Bot ids are normally UUIDs. Keep the path safe for legacy/test ids too.
  const safeId = botId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dataDir(), "bots", safeId, "code-session.lock");
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EPERM");
  }
}

function readLock(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "number") return null;
    return { token: parsed.token, pid: parsed.pid, acquiredAt: parsed.acquiredAt };
  } catch {
    return null;
  }
}

function isStale(path: string, now: number, staleMs: number): boolean {
  const lock = readLock(path);
  if (!lock) {
    try { return now - statSync(path).mtimeMs > staleMs; } catch { return true; }
  }
  return !isProcessAlive(lock.pid) || now - lock.acquiredAt > staleMs;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Cross-process Bot→Code serialization. The lock is an O_EXCL file rather
 * than an in-memory queue, so separate Next workers cannot both launch/link.
 * A dead owner is reclaimed only after its pid is gone and the lease is old.
 */
export async function withBotCodeSessionLock<T>(
  botId: string,
  operation: () => Promise<T>,
  options: BotCodeSessionLockOptions = {},
): Promise<T> {
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const path = lockPath(botId);
  mkdirSync(join(dataDir(), "bots", botId.replace(/[^a-zA-Z0-9._-]/g, "_")), { recursive: true });
  const token = randomUUID();
  const startedAt = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      const fd = openSync(path, "wx");
      try { writeFileSync(fd, `${JSON.stringify({ token, pid: process.pid, acquiredAt: Date.now() })}\n`, "utf8"); }
      finally { closeSync(fd); }
      acquired = true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code !== "EEXIST") throw error;
      if (isStale(path, Date.now(), staleMs)) {
        try { unlinkSync(path); } catch { /* another worker reclaimed it */ }
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw Object.assign(new Error("BotのCodeセッションロックを取得できませんでした"), { status: 409 });
      }
      await sleep(retryMs);
    }
  }
  try {
    return await operation();
  } finally {
    try {
      const current = readLock(path);
      if (current?.token === token) unlinkSync(path);
    } catch { /* best effort; stale-lock recovery handles a crashed cleanup */ }
  }
}

/** Test/diagnostic helper: expose the durable lock location without the lock contents. */
export function botCodeSessionLockPath(botId: string): string {
  return lockPath(botId);
}