/**
 * Leading-edge throttle for "streaming text changed" wakes, one timer per task.
 *
 * The first update in a quiet period wakes at once (first tokens show without waiting for a
 * window), and a continuous stream then wakes at most once per `intervalMs`, always followed by a
 * trailing wake so the last tokens are never left for the next poll.
 */
export const TASK_STREAM_WAKE_MS = 200;

type Timer = ReturnType<typeof setTimeout>;

export function createTaskStreamWake({
  emit,
  intervalMs = TASK_STREAM_WAKE_MS,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  maxIdleEntries = 256,
}: {
  emit: (taskId: string) => void;
  intervalMs?: number;
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, ms: number) => Timer;
  maxIdleEntries?: number;
}): (taskId: string) => void {
  const entries = new Map<string, { lastAt: number; timer: Timer | null }>();
  const fire = (taskId: string) => {
    entries.set(taskId, { lastAt: now(), timer: null });
    emit(taskId);
  };
  return (taskId: string) => {
    const existing = entries.get(taskId);
    if (existing?.timer) return;
    const at = now();
    const waitMs = existing ? intervalMs - (at - existing.lastAt) : 0;
    if (waitMs <= 0) {
      fire(taskId);
      if (entries.size > maxIdleEntries) {
        // Entries are tiny, but finished tasks must not accumulate for the life of the process.
        for (const [id, entry] of entries) {
          if (!entry.timer && at - entry.lastAt > intervalMs) entries.delete(id);
        }
      }
      return;
    }
    const timer = setTimeoutImpl(() => fire(taskId), waitMs);
    (timer as { unref?: () => void }).unref?.();
    entries.set(taskId, { lastAt: existing!.lastAt, timer });
  };
}
