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
