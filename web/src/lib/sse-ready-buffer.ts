import type { UiMessage } from "@/lib/types";

export type MessageListRank = {
  len: number;
  lastCreatedAt: number;
  lastId: string;
  /** Tip message の part 数。0 は `message_start` のプレースホルダ、未指定は不明として扱う。 */
  lastParts?: number;
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
  if (Array.isArray(content.parts)) {
    // Message/part ids are projection keys and can change between live and persisted SSE payloads.
    content.parts = content.parts.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return part;
      const normalized = { ...(part as Record<string, unknown>) };
      delete normalized.id;
      return normalized;
    });
  }
  return JSON.stringify(content) ?? "";
}

function messageListContentKey(messages: unknown[]): string {
  return JSON.stringify(messages.map(messageContentKey)) ?? "";
}

function messagePartCount(message: Partial<UiMessage> | undefined): number {
  const parts = message?.parts;
  return Array.isArray(parts) ? parts.length : 0;
}

/** Compare message lists by length, tip timestamp, then content. */
export function rankMessageList(messages: unknown): MessageListRank {
  const list = Array.isArray(messages) ? messages : [];
  const last = list.at(-1) as Partial<UiMessage> | undefined;
  return {
    len: list.length,
    lastCreatedAt: typeof last?.createdAt === "number" ? last.createdAt : 0,
    lastId: typeof last?.id === "string" ? last.id : "",
    lastParts: messagePartCount(last),
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
  // part を持たない tip は `message_start` のプレースホルダでしかない。その projected id
  // (`msg-N`) は永続 entry id に置き換わるため、ready の後に適用すると part 付きの行を
  // 空に戻したり、render key が一致せず別行として残る（二重表示・未送信に見える）。
  if (candidate.lastParts === 0 && (baseline.lastParts ?? 0) > 0) return false;
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
  "missing_live_session",
  "error",
  "thinking_level_changed",
  "agent_changed",
  "agent_routed",
  "settings_pending",
  "model_changed",
  "revert",
  "unrevert",
  "abort",
  "prompt_accepted",
  "provider_fallback",
  "provider_routed",
  "project_promoted",
  "archived",
  "restored",
  "conversation_reset",
  "code_session_changed",
  "goal_command_stale",
  "transport_retry",
  "project_migrated",
  "project_migration_rolled_back",
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
  const resetsHistory =
    payload.historyReset === true ||
    payload.eventType === "revert" ||
    payload.eventType === "unrevert" ||
    payload.eventType === "conversation_reset";
  if (resetsHistory && Array.isArray(payload.messages)) return payload;
  if (isFresherMessageList(rankMessageList(payload.messages), readyRank)) {
    return payload;
  }
  const next = { ...payload };
  delete next.messages;
  delete next.messageHistory;
  delete next.todos;
  delete next.contextUsage;
  // Ready already delivered the authoritative Goal Loop DTO; a buffered
  // permission/hang snapshot must not rewind the panel to a prior status.
  delete next.goalLoop;
  // Same for compactionSuggested: contextUsage is stripped above, so a stale
  // true/false here would desync the banner from the ready meter.
  delete next.compactionSuggested;
  return next;
}
