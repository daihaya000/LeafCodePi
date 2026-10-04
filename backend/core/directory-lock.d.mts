export function withDirectoryLock<T>(
  options: {
    lockPath: string;
    parentDir: string;
    staleMs: number;
    busyMessage: string;
    maxAttempts?: number;
    waitMs?: number;
    now?: () => number;
    sleep?: (ms: number) => void;
    /** Refresh the lock from a worker thread so sync actions can block the caller's event loop safely. */
    heartbeatMs?: number;
  },
  action: () => T,
): T;

export function withDirectoryLockAsync<T>(
  options: {
    lockPath: string;
    parentDir: string;
    staleMs: number;
    busyMessage: string;
    maxAttempts?: number;
    waitMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void> | void;
  },
  action: () => Promise<T> | T,
): Promise<T>;

/** Refresh a lock directory from a worker thread while its owner event loop is blocked. */
export function registerLockHeartbeat(lockPath: string, owner: string, heartbeatMs: number): () => void;

/** Fresh owner token (`pid:uuid`) for a lock directory. */
export function newOwner(): string;
/** Path of the owner file inside a lock directory. */
export function ownerFile(lockPath: string): string;
/** The owner token stored in a lock directory, or null when missing/unreadable. */
export function readOwnerSync(lockPath: string): string | null;
/**
 * Whether a lock of the given age and owner token may be reclaimed: past `staleMs`, and its owner
 * process is gone (or unidentifiable, or past the live-owner hard cap).
 */
export function reclaimable(ageMs: number, owner: string | null, staleMs: number): boolean;