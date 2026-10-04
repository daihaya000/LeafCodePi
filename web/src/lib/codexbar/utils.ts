import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { lookup as osLookup, promises as dnsPromises } from "node:dns";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

type LookupAddress = { address: string; family: number };

/** Head start that keeps hosts-file / MagicDNS answers ahead of the direct query. */
const OS_RESOLVER_HEAD_START_MS = 50;

/**
 * On some Windows setups `getaddrinfo` stalls ~12s for individual hosts while a direct
 * DNS query answers in well under a second, which starves every request budget. Race the
 * OS resolver against a c-ares query and use the first usable answer.
 *
 * ponytail: two lookups per connection; drop the c-ares leg once getaddrinfo behaves.
 */
export function racingLookup(
  hostname: string,
  options: { family?: number | "IPv4" | "IPv6"; hints?: number; all?: boolean },
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  const wanted =
    options.family === 4 || options.family === "IPv4"
      ? 4
      : options.family === 6 || options.family === "IPv6"
        ? 6
        : 0;
  const viaOs = new Promise<LookupAddress[]>((resolve, reject) => {
    osLookup(hostname, { ...options, all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    );
  });
  const query = async (family: 4 | 6): Promise<LookupAddress[]> => {
    const addresses =
      family === 4
        ? await dnsPromises.resolve4(hostname)
        : await dnsPromises.resolve6(hostname);
    return addresses.map((address) => ({ address, family }));
  };
  const viaDns = new Promise<void>((resolve) =>
    setTimeout(resolve, OS_RESOLVER_HEAD_START_MS),
  ).then(async () => {
    if (wanted !== 0) return query(wanted);
    const settled = await Promise.allSettled([query(6), query(4)]);
    const found = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (found.length === 0) throw new Error(`DNS query returned no records: ${hostname}`);
    return found;
  });

  let done = false;
  let pending = 2;
  const fail = (err: NodeJS.ErrnoException) => {
    pending -= 1;
    if (done || pending > 0) return;
    done = true;
    (callback as (err: NodeJS.ErrnoException) => void)(err);
  };
  const succeed = (addresses: LookupAddress[]) => {
    if (done) return;
    if (addresses.length === 0) {
      fail(Object.assign(new Error(`No address found: ${hostname}`), { code: "ENOTFOUND" }));
      return;
    }
    done = true;
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };
  void viaOs.then(succeed, fail);
  void viaDns.then(succeed, fail);
}

/** Shared connection pool: fast name resolution plus room for slow network paths. */
const usageAgent = new Agent({
  connect: { lookup: racingLookup },
  connectTimeout: 20_000,
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 1_000,
});

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function flexibleNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function windowTitle(durationMs: number | null, isPrimary: boolean): string {
  if (durationMs === null) return isPrimary ? "セッション" : "週間";
  const minutes = durationMs / 60_000;
  if (minutes >= 10000 && minutes <= 10160) return "週間";
  if (Math.abs(minutes - 300) < 30) return "5時間";
  if (minutes % 1440 === 0) return `${Math.floor(minutes / 1440)}日`;
  if (minutes % 60 === 0) return `${Math.floor(minutes / 60)}時間`;
  return `${Math.floor(minutes)}分`;
}

export function creditsFillPercent(
  used: number | null,
  limit: number | null,
): number | null {
  if (limit === null || !(limit > 0)) return null;
  return clamp(((used ?? 0) / limit) * 100, 0, 100);
}

export function representativePercent(snapshot: {
  windows: { usedPercent: number; countsTowardLimit: boolean }[];
  creditsEnabled: boolean;
  creditsUsed: number | null;
  creditsLimit: number | null;
}): number | null {
  const counting = snapshot.windows.filter((w) => w.countsTowardLimit);
  const effective = counting.length > 0 ? counting : snapshot.windows;
  let percent: number | null =
    effective.length > 0 ? Math.max(...effective.map((w) => w.usedPercent)) : null;
  const credits = snapshot.creditsEnabled
    ? creditsFillPercent(snapshot.creditsUsed, snapshot.creditsLimit)
    : null;
  if (credits !== null && (percent === null || credits > percent)) percent = credits;
  return percent;
}

export const LIMIT_THRESHOLD_PERCENT = 90;
export const MAXED_THRESHOLD_PERCENT = 99.5;

export function isLimited(percent: number): boolean {
  return percent >= LIMIT_THRESHOLD_PERCENT;
}

export function isMaxed(percent: number): boolean {
  return percent >= MAXED_THRESHOLD_PERCENT;
}

/** Decode JWT payload (no verify). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    payload = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    return asRecord(JSON.parse(Buffer.from(payload, "base64").toString("utf8")));
  } catch {
    return null;
  }
}

/**
 * Atomically write text (tmp + replace). Best-effort on Windows when rename
 * cannot overwrite an existing file.
 */
export function atomicWriteText(filePath: string, content: string, mode?: number): void {
  mkdirSync(dirname(filePath), { recursive: true, ...(mode === undefined ? {} : { mode: 0o700 }) });
  const tmp = mode === undefined
    ? `${filePath}.leafcode-tmp`
    : `${filePath}.${randomUUID()}.leafcode-tmp`;
  writeFileSync(tmp, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  try {
    renameSync(tmp, filePath);
  } catch {
    try {
      copyFileSync(tmp, filePath);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
  if (mode !== undefined && process.platform !== "win32") chmodSync(filePath, mode);
}

const singleFlights = new Map<string, Promise<unknown>>();

/** Share one in-flight run per key (e.g. a rotating OAuth refresh token must not be spent twice concurrently). */
export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = singleFlights.get(key);
  if (pending) return pending as Promise<T>;
  const started: Promise<T> = run().finally(() => {
    if (singleFlights.get(key) === started) singleFlights.delete(key);
  });
  singleFlights.set(key, started);
  return started;
}

/**
 * Cross-process refresh lock. OAuth refresh tokens rotate, so the CLI and the WebUI
 * must not spend the same one concurrently. A PID/start-key lock serializes them
 * across processes; keyed stale locks are reclaimed only after owner exit or confirmed
 * PID reuse. Legacy/unverifiable owners fail closed. Timeout rejects rather than refreshing unlocked.
 */
const REFRESH_LOCK_STALE_MS = 30_000;

interface RefreshLockOwner {
  pid: number;
  processKey?: string;
}

const PROCESS_START_KEY_CACHE_TTL_MS = 30_000;
const PROCESS_START_KEY_FAILURE_CACHE_TTL_MS = 1_000;
const PROCESS_START_KEY_CACHE_LIMIT = 32;
const processStartKeyCache = new Map<number, { checkedAt: number; key?: string }>();

function cacheProcessStartKey(pid: number, key?: string): void {
  if (processStartKeyCache.size >= PROCESS_START_KEY_CACHE_LIMIT) {
    const oldest = [...processStartKeyCache.entries()].sort((a, b) => a[1].checkedAt - b[1].checkedAt)[0];
    if (oldest) processStartKeyCache.delete(oldest[0]);
  }
  processStartKeyCache.set(pid, { checkedAt: Date.now(), ...(key ? { key } : {}) });
}

function processStartKey(pid: number): string | undefined {
  const cached = processStartKeyCache.get(pid);
  if (cached && Date.now() - cached.checkedAt < (cached.key ? PROCESS_START_KEY_CACHE_TTL_MS : PROCESS_START_KEY_FAILURE_CACHE_TTL_MS)) return cached.key;
  if (cached) processStartKeyCache.delete(pid);

  let key: string | undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const startTicks = commandEnd >= 0 ? stat.slice(commandEnd + 1).trim().split(/\s+/)[19] : undefined;
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (startTicks && bootId) key = `linux:${bootId}:${startTicks}`;
    } else if (process.platform === "win32") {
      const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000, windowsHide: true }).trim();
      if (raw) key = `win:${raw}`;
    } else if (process.platform === "darwin") {
      const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).trim();
      if (raw) key = `ps:${raw}`;
    }
  } catch {
    cacheProcessStartKey(pid);
    return undefined;
  }
  cacheProcessStartKey(pid, key);
  return key;
}

function readRefreshLockOwner(lockPath: string): RefreshLockOwner | null | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8").trim();
  } catch {
    return undefined; // Unreadable or concurrently released: owner state is unknown.
  }
  const legacyPid = Number(raw);
  if (Number.isSafeInteger(legacyPid) && legacyPid > 0) return { pid: legacyPid };
  try {
    const owner = JSON.parse(raw) as { pid?: unknown; processKey?: unknown };
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return null;
    if (owner.processKey !== undefined && (typeof owner.processKey !== "string" || !owner.processKey)) return null;
    return { pid: owner.pid as number, ...(typeof owner.processKey === "string" ? { processKey: owner.processKey } : {}) };
  } catch {
    return null;
  }
}

function isRefreshLockOwnerAlive(lockPath: string): boolean {
  const owner = readRefreshLockOwner(lockPath);
  if (owner === null) return false; // A stale, malformed lock cannot identify a live holder.
  if (owner === undefined) return true;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code !== "EPERM") return true; // Unknown probe failure: preserve the lock.
  }
  if (!owner.processKey) return true; // Legacy lock or unavailable start identity: fail closed.
  const currentKey = processStartKey(owner.pid);
  return currentKey === undefined || currentKey === owner.processKey;
}

function isRefreshLockStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > REFRESH_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Serialize stale removal because cross-process start-key probes can block. */
function reclaimStaleRefreshLock(lockPath: string, reclaimPath: string): void {
  if (!isRefreshLockStale(lockPath) || isRefreshLockOwnerAlive(lockPath)) return;
  try {
    mkdirSync(reclaimPath, { mode: 0o700 });
  } catch {
    return; // Another contender owns the reclaim transaction.
  }
  try {
    if (isRefreshLockStale(lockPath) && !isRefreshLockOwnerAlive(lockPath)) unlinkSync(lockPath);
  } catch {
    // The old lock was released or replaced while reclaiming.
  } finally {
    try { rmdirSync(reclaimPath); } catch { /* another contender already recovered it */ }
  }
}

export async function withRefreshFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.leafcode-refresh.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const processKey = processStartKey(process.pid);
  // The nonce makes this acquisition's file content unique, so release can tell it from a
  // lock another process created after reclaiming ours.
  const ownerData = JSON.stringify({ pid: process.pid, ...(processKey ? { processKey } : {}), nonce: randomUUID() });
  const deadline = Date.now() + REFRESH_LOCK_STALE_MS;
  let fd: number | undefined;
  for (;;) {
    if (Date.now() >= deadline) {
      // Never spend a rotating refresh token without cross-process exclusion.
      throw new Error("Timed out waiting for OAuth refresh lock");
    }
    try {
      if (Date.now() - statSync(reclaimPath).mtimeMs <= REFRESH_LOCK_STALE_MS) {
        await new Promise<void>((done) => { setTimeout(done, 25); });
        continue;
      }
      // Recover a reclaim guard left by a process that exited mid-transaction.
      rmdirSync(reclaimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await new Promise<void>((done) => { setTimeout(done, 25); });
        continue;
      }
    }
    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, ownerData);
      break;
    } catch {
      if (Date.now() >= deadline) {
        // Never spend a rotating refresh token without cross-process exclusion.
        throw new Error("Timed out waiting for OAuth refresh lock");
      }
      reclaimStaleRefreshLock(lockPath, reclaimPath);
      await new Promise<void>((done) => { setTimeout(done, 25); });
    }
  }
  return run().finally(() => {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try {
      // Only remove the lock while it still carries our own owner record.
      if (readFileSync(lockPath, "utf8").trim() === ownerData) unlinkSync(lockPath);
    } catch { /* already released or replaced */ }
  });
}

export function cleanApiKey(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.length > 0 ? value : null;
}

export async function fetchText(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; body: string; ok: boolean }> {
  const { timeoutMs = 30_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const parent = rest.signal;
  const abortFromParent = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const res = await undiciFetch(url, {
      ...(rest as UndiciRequestInit),
      signal: ctrl.signal,
      dispatcher: usageAgent,
    });
    const body = await res.text();
    return { status: res.status, body, ok: res.ok };
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener("abort", abortFromParent);
  }
}
