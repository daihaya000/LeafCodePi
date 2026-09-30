/**
 * Snapshot coalescing decided per session event. High-frequency stream events are
 * emitted as deltas, lifecycle events render nothing, and a burst inside the
 * throttle window collapses into a single snapshot. Timers and emitting stay with
 * the caller.
 */
/** High-frequency stream events — coalesce snapshot SSE instead of emitting every token. */
export const THROTTLED_SNAPSHOT_EVENTS = new Set([
  "message_update",
  "tool_execution_update",
]);
export const SNAPSHOT_THROTTLE_MS = 100;
/** These lifecycle events do not change anything rendered by TaskView. */
export const NON_RENDERING_SESSION_EVENTS = new Set([
  "turn_start",
  "turn_end",
  "entry_appended",
]);

/**
 * What to do with one event: "skip" for a non-rendering event, "coalesce" when a
 * throttled event arrives while a full snapshot is still queued (the full one will
 * carry it), otherwise "schedule" with whether the pending snapshot is a delta.
 */
export function classifySnapshotEvent(eventType, pending) {
  if (NON_RENDERING_SESSION_EVENTS.has(eventType)) return { action: "skip" };
  const isDelta = THROTTLED_SNAPSHOT_EVENTS.has(eventType);
  if (isDelta && pending?.eventType && pending.isDelta !== true) return { action: "coalesce" };
  return { action: "schedule", isDelta };
}

/**
 * The snapshot a fired timer should emit: whatever the pending slot holds at that
 * moment, defaulting to nothing so the caller can fall back to the last event type.
 */
export function pendingSnapshotFlush(pending) {
  return {
    eventType: pending?.eventType ?? null,
    extra: pending?.extra,
    isDelta: pending?.isDelta === true,
  };
}
