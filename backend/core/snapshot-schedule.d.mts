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
