/** Stable identity key for a process ID, or undefined when the OS cannot verify it. */
export function processStartKey(pid: number, options?: { platform?: string }): string | undefined;
