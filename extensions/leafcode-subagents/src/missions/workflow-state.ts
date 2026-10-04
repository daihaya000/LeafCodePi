import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../shared/atomic-json.ts";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, isRetryableFileSystemError, waitForFileSystemRetry } from "../shared/file-system-retry.ts";
import { assertWorkflowJsonValue } from "../workflows/scripted-workflow.ts";
import type { MissionStoreLocation } from "./types.ts";
import { validateMissionId } from "./store.ts";

const STATE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATE_LOCK_STALE_MS = 60_000;
export const MISSION_STATE_MAX_BYTES = 256 * 1024;

export interface MissionWorkflowState {
	path: string;
	get(key: string): unknown;
	set(key: string, value: unknown): void;
}

export function missionStatePath(location: MissionStoreLocation, missionId: string): string {
	return path.join(location.missionDir, validateMissionId(missionId), "state.json");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

interface StateLockOwner {
	pid: number;
	token: string;
	createdAt: number;
	processKey?: string;
}

function linuxProcessStartKey(pid: number): string | undefined {
	try {
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
		const tail = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
		return tail[19] ? rememberStartKey(pid, `linux:${tail[19]}`) : undefined;
	} catch {
		return undefined;
	}
}

function psProcessStartKey(pid: number): string | undefined {
	try {
		const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).trim();
		return raw ? rememberStartKey(pid, `ps:${raw}`) : undefined;
	} catch {
		return undefined;
	}
}

function windowsProcessStartKey(pid: number): string | undefined {
	try {
		const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000, windowsHide: true }).trim();
		return raw ? rememberStartKey(pid, `win:${raw}`) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A live process's start key never changes, so re-probing it only costs another
 * synchronous PowerShell spawn (up to 1s of blocked event loop) per contender.
 * Cache successful probes briefly; a miss is not cached, so a process that dies
 * mid-window is re-probed rather than staying keyless for the whole window.
 */
const START_KEY_CACHE_TTL_MS = 30_000;
const START_KEY_CACHE_LIMIT = 32;
const startKeyCache = new Map<number, { resolvedAt: number; key: string }>();

function cachedStartKey(pid: number): string | undefined {
	const cached = startKeyCache.get(pid);
	if (!cached) return undefined;
	if (Date.now() - cached.resolvedAt >= START_KEY_CACHE_TTL_MS) {
		startKeyCache.delete(pid);
		return undefined;
	}
	return cached.key;
}

function rememberStartKey(pid: number, key: string | undefined): string | undefined {
	if (!key) return undefined;
	if (startKeyCache.size >= START_KEY_CACHE_LIMIT) {
		const oldest = [...startKeyCache.entries()].sort((a, b) => a[1].resolvedAt - b[1].resolvedAt)[0];
		if (oldest) startKeyCache.delete(oldest[0]);
	}
	startKeyCache.set(pid, { resolvedAt: Date.now(), key });
	return key;
}

/** Test-only: count start-key probes so a test can assert none happened. */
let startKeyProbeCount = 0;

/** Test-only: forget memoized process start keys and reset the probe counter. */
export function resetProcessStartKeyCacheForTests(): void {
	startKeyCache.clear();
	startKeyProbeCount = 0;
}

/** Test-only: how many start-key probes ran since the last reset. */
export function startKeyProbeCountForTests(): number {
	return startKeyProbeCount;
}

function processStartKey(pid: number): string | undefined {
	startKeyProbeCount += 1;
	if (process.platform === "linux") return cachedStartKey(pid) ?? linuxProcessStartKey(pid) ?? psProcessStartKey(pid);
	if (process.platform === "win32") return cachedStartKey(pid) ?? windowsProcessStartKey(pid);
	return undefined;
}

/**
 * 自プロセスの起動キー。powershell(WMI問い合わせ)の同期起動（約1〜2秒）を伴うため
 * モジュール評価時に実行せず、ロック照合で最初に必要になった時点で一度だけ解決する。
 * 値はプロセス内で不変なので、初回評価を遅らせるだけの意味論変更は無い。
 */
let CURRENT_PROCESS_KEY: string | undefined;
function currentProcessKeyFor(): string | undefined {
	if (CURRENT_PROCESS_KEY === undefined) {
		CURRENT_PROCESS_KEY = processStartKey(process.pid);
	}
	return CURRENT_PROCESS_KEY;
}

function readStateLockOwner(lockPath: string): StateLockOwner | undefined {
	try {
		const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8")) as { pid?: unknown; token?: unknown; createdAt?: unknown; processKey?: unknown };
		if (Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0 && typeof owner.token === "string" && owner.token && Number.isSafeInteger(owner.createdAt)) {
			return {
				pid: owner.pid as number,
				token: owner.token,
				createdAt: owner.createdAt as number,
				...(typeof owner.processKey === "string" && owner.processKey ? { processKey: owner.processKey } : {}),
			};
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** A live owner whose start key cannot be verified keeps its lock this long before it is aged out. */
const UNVERIFIABLE_OWNER_HARD_CAP_MS = 10 * 60_000;

/** Exported for tests, which inject the start-key probe. */
export function stateLockIsStale(
	lockPath: string,
	now = Date.now(),
	probeStartKey: (pid: number) => string | undefined = processStartKey,
): boolean {
	const owner = readStateLockOwner(lockPath);
	if (owner) {
		// A young lock can never be stale, so skip the ownership probe: it costs a
		// synchronous PowerShell spawn (up to 1s of blocked event loop) per contender.
		if (now - owner.createdAt < STATE_LOCK_STALE_MS) return false;
		if (!isProcessAlive(owner.pid)) return true;
		if (owner.processKey) {
			const currentProcessKey = owner.pid === process.pid ? currentProcessKeyFor() : probeStartKey(owner.pid);
			// The owner's pid is alive. A failed/timed-out start-key probe (slow PowerShell under load) says nothing
			// about reuse, so it must not steal a live owner's lock: keep it until the hard cap, which only
			// bounds how long an unverifiable (possibly pid-reused) owner can pin the lock.
			if (!currentProcessKey) return now - owner.createdAt >= UNVERIFIABLE_OWNER_HARD_CAP_MS;
			return owner.processKey !== currentProcessKey;
		}
		// No start-key: PID liveness alone cannot detect reuse — age the lock out instead.
		return true;
	}
	try {
		return now - fs.statSync(lockPath).mtimeMs > STATE_LOCK_STALE_MS;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function removeOwnedStateLock(lockPath: string, owner: StateLockOwner): void {
	const current = readStateLockOwner(lockPath);
	if (current?.token !== owner.token) return;
	fs.rmSync(lockPath, { recursive: true, force: true });
}

function staleDirectoryExists(dirPath: string, now = Date.now()): boolean {
	try {
		return now - fs.statSync(dirPath).mtimeMs > STATE_LOCK_STALE_MS;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function tryMakeDirectory(dirPath: string, mode: number): boolean {
	try {
		fs.mkdirSync(dirPath, { mode });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

function waitForStateLock(delayMs: number | undefined, lockPath: string): void {
	if (delayMs === undefined) throw new Error(`Timed out acquiring mission state lock '${lockPath}'.`);
	waitForFileSystemRetry(delayMs);
}

function reclaimStaleStateLock(lockPath: string, reclaimPath: string): boolean {
	if (!stateLockIsStale(lockPath)) return false;
	if (!tryMakeDirectory(reclaimPath, 0o700)) return false;
	try {
		if (!stateLockIsStale(lockPath)) return false;
		fs.rmSync(lockPath, { recursive: true, force: true });
		return true;
	} finally {
		fs.rmSync(reclaimPath, { recursive: true, force: true });
	}
}

function withStateFileLock<T>(filePath: string, operation: () => T): T {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const lockPath = `${filePath}.lock`;
	const reclaimPath = `${lockPath}.reclaim`;
	let owner: StateLockOwner | undefined;
	for (let attempt = 0; ; attempt++) {
		if (fs.existsSync(reclaimPath)) {
			if (staleDirectoryExists(reclaimPath)) {
				fs.rmSync(reclaimPath, { recursive: true, force: true });
				continue;
			}
			waitForStateLock(DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS[attempt], lockPath);
			continue;
		}
		let acquired = false;
		try {
			acquired = tryMakeDirectory(lockPath, 0o700);
		} catch (error) {
			if (isRetryableFileSystemError(error)) {
				waitForStateLock(DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS[attempt], lockPath);
				continue;
			}
			throw new Error(`Failed to acquire mission state lock '${lockPath}': ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!acquired) {
			if (reclaimStaleStateLock(lockPath, reclaimPath)) continue;
			waitForStateLock(DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS[attempt], lockPath);
			continue;
		}
		const processKey = currentProcessKeyFor();
		owner = { pid: process.pid, token: randomUUID(), createdAt: Date.now(), ...(processKey ? { processKey } : {}) };
		try {
			fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
		} catch (error) {
			fs.rmSync(lockPath, { recursive: true, force: true });
			owner = undefined;
			throw error;
		}
		break;
	}
	try {
		return operation();
	} finally {
		if (owner) removeOwnedStateLock(lockPath, owner);
	}
}

function validateStateKey(value: unknown): string {
	if (typeof value !== "string" || !STATE_KEY_PATTERN.test(value)) {
		throw new Error("state key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.");
	}
	return value;
}

export function createMissionWorkflowState(location: MissionStoreLocation, missionId: string): MissionWorkflowState {
	const filePath = missionStatePath(location, missionId);
	let loaded = false;
	let values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

	const readStateFile = (): Record<string, unknown> => {
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Record<string, unknown>;
			throw new Error(`Failed to read mission state '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
		const bytes = Buffer.byteLength(raw);
		if (bytes > MISSION_STATE_MAX_BYTES) throw new Error(`Mission state file '${filePath}' exceeds the 256 KiB limit (${bytes} bytes).`);
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be a JSON object");
			assertWorkflowJsonValue(parsed, "mission state");
			return Object.assign(Object.create(null) as Record<string, unknown>, parsed);
		} catch (error) {
			throw new Error(`Invalid mission state file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const load = (): Record<string, unknown> => {
		if (loaded) return values;
		values = readStateFile();
		loaded = true;
		return values;
	};

	return {
		path: filePath,
		get(key) {
			const validKey = validateStateKey(key);
			const current = load();
			return Object.hasOwn(current, validKey) ? current[validKey] : undefined;
		},
		set(key, value) {
			const validKey = validateStateKey(key);
			assertWorkflowJsonValue(value, `state.set('${validKey}') value`);
			withStateFileLock(filePath, () => {
				const next = Object.assign(Object.create(null) as Record<string, unknown>, readStateFile(), { [validKey]: value });
				const bytes = Buffer.byteLength(JSON.stringify(next, null, 2));
				if (bytes > MISSION_STATE_MAX_BYTES) throw new Error(`Mission state exceeds the 256 KiB limit (${bytes} bytes; maximum ${MISSION_STATE_MAX_BYTES} bytes).`);
				writePrivateAtomicJson(filePath, next);
				values = next;
				loaded = true;
			});
		},
	};
}
