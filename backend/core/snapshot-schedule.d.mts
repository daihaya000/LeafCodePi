export const THROTTLED_SNAPSHOT_EVENTS: Set<string>;
export const SNAPSHOT_THROTTLE_MS: number;
export const NON_RENDERING_SESSION_EVENTS: Set<string>;

export type SnapshotEventDecision =
  | { action: "skip" }
  | { action: "coalesce" }
  | { action: "schedule"; isDelta: boolean };

export function classifySnapshotEvent(
  eventType: string,
  pending: { eventType?: string | null; isDelta?: boolean } | undefined,
): SnapshotEventDecision;

export function pendingSnapshotFlush(
  pending: { eventType?: string | null; extra?: Record<string, unknown>; isDelta?: boolean } | undefined,
): { eventType: string | null; extra: Record<string, unknown> | undefined; isDelta: boolean };

/**
 * Cancels an armed timer, clears the pending slots and emits what was queued, in
 * that order. Returns true when a timer was armed.
 */
export function flushPendingSnapshotOnUnsubscribe(
  pending: {
    timer?: unknown;
    eventType?: string | null;
    extra?: Record<string, unknown>;
    isDelta?: boolean;
  } | undefined,
  deps: {
    clearTimer: (timer: unknown) => void;
    /** Clears the live's pending slots; runs before any emit. */
    clearPending: () => void;
    emitDelta: (eventType: string) => void;
    emitSnapshot: (eventType: string, extra?: Record<string, unknown>) => void;
  },
): boolean;
