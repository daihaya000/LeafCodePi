import type { UiMessage } from "@/lib/types";

export type MessageListRank = {
  len: number;
  lastCreatedAt: number;
  lastId: string;
};

/** Compare message lists by length, then tip timestamp, then tip id. */
export function rankMessageList(messages: unknown): MessageListRank {
  const list = Array.isArray(messages) ? messages : [];
  const last = list.at(-1) as Partial<UiMessage> | undefined;
  return {
    len: list.length,
    lastCreatedAt: typeof last?.createdAt === "number" ? last.createdAt : 0,
    lastId: typeof last?.id === "string" ? last.id : "",
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
  return Boolean(candidate.lastId) && candidate.lastId !== baseline.lastId;
}

/**
 * After the ready snapshot, only flush buffered events that are still newer.
 * Older snapshots would rewind the client; stale deltas would overwrite the tip.
 */
export function shouldFlushPendingAfterReady(
  payload: Record<string, unknown>,
  readyRank: MessageListRank,
): boolean {
  if (payload.type === "snapshot") {
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
    if (createdAt === readyRank.lastCreatedAt && id && id !== readyRank.lastId) {
      return true;
    }
    return false;
  }
  return true;
}
