/**
 * The last pending snapshot per task, kept so a reader (today the Web relay, after
 * the switch the Backend's internal API) can re-display a task's state without
 * holding the live session itself. This store owns no timers and emits nothing: the
 * coalescing rules stay in `snapshot-schedule.mjs`, and the caller decides when a
 * value is recorded.
 *
 * Entries are keyed by task id. Re-recording a task replaces its entry and moves it
 * to the end of the read order, so a bounded store evicts the least recently written
 * task first. A cap below 1 keeps nothing.
 */
export function createPendingSnapshotStore({ limit = 512 } = {}) {
  const capacity = Number.isInteger(limit) && limit > 0 ? limit : 0;
  const entries = new Map();

  function record(taskId, snapshot) {
    if (capacity === 0 || typeof taskId !== "string" || taskId === "") return false;
    // Delete first so a re-recorded task becomes the most recent entry.
    entries.delete(taskId);
    entries.set(taskId, {
      eventType: snapshot?.eventType ?? null,
      extra: snapshot?.extra,
      isDelta: snapshot?.isDelta === true,
    });
    while (entries.size > capacity) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
    return true;
  }

  function read(taskId) {
    const entry = entries.get(taskId);
    if (!entry) return null;
    // Copies: a reader must not be able to mutate what the writer recorded.
    return { taskId, ...entry };
  }

  function clear(taskId) {
    return entries.delete(taskId);
  }

  function list() {
    return [...entries].map(([taskId, entry]) => ({ taskId, ...entry }));
  }

  return { record, read, clear, list, get size() { return entries.size; } };
}
