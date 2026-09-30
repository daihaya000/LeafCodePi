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
