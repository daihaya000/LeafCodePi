import type { UiMessage } from "@/lib/types";

export type MessageListRank = {
  len: number;
  lastCreatedAt: number;
  lastId: string;
  /** Stable content fingerprint, excluding projected id/timestamp churn. */
  contentKey?: string;
};

function messageContentKey(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return JSON.stringify(message) ?? "";
  }
  const content = { ...(message as Record<string, unknown>) };
  delete content.id;
  delete content.createdAt;
  return JSON.stringify(content) ?? "";
}

function messageListContentKey(messages: unknown[]): string {
  return JSON.stringify(messages.map(messageContentKey)) ?? "";
}

/** Compare message lists by length, tip timestamp, then content. */
export function rankMessageList(messages: unknown): MessageListRank {
  const list = Array.isArray(messages) ? messages : [];
  const last = list.at(-1) as Partial<UiMessage> | undefined;
  return {
    len: list.length,
    lastCreatedAt: typeof last?.createdAt === "number" ? last.createdAt : 0,
    lastId: typeof last?.id === "string" ? last.id : "",
    contentKey: messageListContentKey(list),
  };
}

export function isFresherMessageList(
  candidate: MessageListRank,
  baseline: MessageListRank,
): boolean {
  if (candidate.len !== baseline.len) return candidate.len > baseline.len;
  if (candidate.lastCreatedAt !== baseline.lastCreatedAt) {
    return candidate.lastCreatedAt > baseline.lastCreatedAt;
  }
  // Same length + same tip timestamp: ignore projected id churn, but keep
  // legitimate content/parts updates that can share both values.
  return (candidate.contentKey ?? "") !== (baseline.contentKey ?? "");
}

/**
 * After the ready snapshot, only flush buffered events that are still newer.
 * Older snapshots would rewind the client; stale deltas would overwrite the tip.
 * Control events (permission, hang retry, errors) must still flush even when
 * the message list is unchanged — ready does not always carry those fields.
 */
export const SSE_CONTROL_SNAPSHOT_EVENT_TYPES = new Set([
  "permission_request",
  "permission_resolved",
  "question_request",
  "question_resolved",
  "hang_retry",
  "hang_abort",
  "hang_idle",
  "error",
  "thinking_level_changed",
  "agent_changed",
  "revert",
  "unrevert",
  "abort",
  "prompt_accepted",
  "provider_fallback",
  "provider_routed",
  "project_promoted",
  "archived",
  "restored",
]);

export function isControlSnapshot(payload: Record<string, unknown>): boolean {
  return (
    payload.type === "snapshot" &&
    typeof payload.eventType === "string" &&
    SSE_CONTROL_SNAPSHOT_EVENT_TYPES.has(payload.eventType)
  );
}

const REQUEST_EVENT_FOR_RESOLVED: Record<string, string> = {
  permission_resolved: "permission_request",
  question_resolved: "question_request",
};

const RESOLVED_EVENT_FOR_REQUEST: Record<string, string> = {
  permission_request: "permission_resolved",
  question_request: "question_resolved",
};

function removeControlEvent(
  pending: Record<string, unknown>[],
  eventType: string,
): boolean {
  const index = pending.findIndex(
    (item) => item.type === "snapshot" && item.eventType === eventType,
  );
  if (index < 0) return false;
  pending.splice(index, 1);
  return true;
}

/**
 * Coalesce live events while the ready snapshot is still being fetched.
 * History snapshots still replace earlier history + trailing deltas, but
 * control events (permission, hang retry, errors) stay until flush.
 * Request/resolved pairs cancel out so a stale resolved cannot clear a newer
 * request, and a resolved request does not flash after ready.
 */
export function bufferPendingSsePayload(
  pending: Record<string, unknown>[],
  payload: Record<string, unknown>,
): void {
  if (payload.type === "delta") {
    const previous = pending.at(-1);
    if (previous?.type === "delta") {
      pending[pending.length - 1] = payload;
    } else {
      pending.push(payload);
    }
    return;
  }

  if (isControlSnapshot(payload)) {
    const eventType = payload.eventType as string;
    const requestPair = REQUEST_EVENT_FOR_RESOLVED[eventType];
    if (requestPair) {
      // Resolved cancels a buffered request → net no-op (no flash after ready).
      if (removeControlEvent(pending, requestPair)) return;
    } else {
      const resolvedPair = RESOLVED_EVENT_FOR_REQUEST[eventType];
      if (resolvedPair) {
        // Newer request supersedes a buffered resolved clear.
        removeControlEvent(pending, resolvedPair);
      }
    }

    const existing = pending.findIndex(
      (item) => item.type === "snapshot" && item.eventType === eventType,
    );
    if (existing >= 0) {
      pending[existing] = payload;
    } else {
      pending.push(payload);
    }
    return;
  }

  const kept = pending.filter(isControlSnapshot);
  pending.length = 0;
  pending.push(...kept, payload);
}

export function shouldFlushPendingAfterReady(
  payload: Record<string, unknown>,
  readyRank: MessageListRank,
): boolean {
  if (payload.type === "snapshot") {
    const eventType = payload.eventType;
    if (typeof eventType === "string" && SSE_CONTROL_SNAPSHOT_EVENT_TYPES.has(eventType)) {
      return true;
    }
    return isFresherMessageList(rankMessageList(payload.messages), readyRank);
  }
  if (payload.type === "delta") {
    const message = payload.message;
    if (!message || typeof message !== "object") return true;
    const tip = message as Partial<UiMessage>;
    const createdAt = typeof tip.createdAt === "number" ? tip.createdAt : 0;
    const id = typeof tip.id === "string" ? tip.id : "";
    if (createdAt > readyRank.lastCreatedAt) return true;
    // Same tip id = streaming update of the ready tail message.
    if (id && id === readyRank.lastId) return true;
    // Same timestamp + different id is usually the projected tip (msg-N) vs
    // ready's entry id — flushing would rewind the tip via renderKey upsert.
    return false;
  }
  return true;
}

/**
 * Control events must still flush after ready, but their embedded history may
 * be older than the ready snapshot. Strip stale timeline fields so TaskView
 * applies permission/hang state without rewinding messages.
 */
export function preparePendingPayloadForReadyFlush(
  payload: Record<string, unknown>,
  readyRank: MessageListRank,
): Record<string, unknown> | null {
  if (!shouldFlushPendingAfterReady(payload, readyRank)) return null;
  if (!isControlSnapshot(payload)) return payload;
  if (isFresherMessageList(rankMessageList(payload.messages), readyRank)) {
    return payload;
  }
  const next = { ...payload };
  delete next.messages;
  delete next.todos;
  delete next.contextUsage;
  return next;
}
