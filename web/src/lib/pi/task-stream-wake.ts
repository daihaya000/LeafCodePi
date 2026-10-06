/**
 * Leading-edge throttle for "streaming text changed" wakes, one timer per task.
 *
 * The first update in a quiet period wakes at once (first tokens show without waiting for a
 * window), and a continuous stream then wakes at most once per `intervalMs`, always followed by a
 * trailing wake evaluates only the latest coalesced payload factory, so the last tokens are never left for the next poll.
 */
export const TASK_STREAM_WAKE_MS = 300;

type Timer = ReturnType<typeof setTimeout>;

export function createTaskStreamWake({
  emit,
  intervalMs = TASK_STREAM_WAKE_MS,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  maxIdleEntries = 256,
}: {
  emit: (taskId: string, payload?: unknown) => void;
  intervalMs?: number;
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, ms: number) => Timer;
  maxIdleEntries?: number;
}): (taskId: string, payloadFactory?: () => unknown) => void {
  const entries = new Map<string, { lastAt: number; timer: Timer | null; payloadFactory?: () => unknown }>();
  const fire = (taskId: string, payloadFactory?: () => unknown) => {
    entries.set(taskId, { lastAt: now(), timer: null });
    let payload: unknown;
    try {
      payload = payloadFactory?.();
    } catch {
      // A failed projection is recovered by the stream's slower safety poll.
      return;
    }
    if (payload === undefined) emit(taskId);
    else emit(taskId, payload);
  };
  return (taskId: string, payloadFactory?: () => unknown) => {
    const existing = entries.get(taskId);
    if (existing?.timer) {
      existing.payloadFactory = payloadFactory;
      return;
    }
    const at = now();
    const waitMs = existing ? intervalMs - (at - existing.lastAt) : 0;
    if (waitMs <= 0) {
      fire(taskId, payloadFactory);
      if (entries.size > maxIdleEntries) {
        // Entries are tiny, but finished tasks must not accumulate for the life of the process.
        for (const [id, entry] of entries) {
          if (!entry.timer && at - entry.lastAt > intervalMs) entries.delete(id);
        }
      }
      return;
    }
    const timer = setTimeoutImpl(() => fire(taskId, entries.get(taskId)?.payloadFactory), waitMs);
    (timer as { unref?: () => void }).unref?.();
    entries.set(taskId, { lastAt: existing!.lastAt, timer, payloadFactory });
  };
}
