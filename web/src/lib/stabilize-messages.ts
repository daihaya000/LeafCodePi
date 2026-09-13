import type { UiMessage } from "@/lib/types";

const messageFingerprintCache = new WeakMap<object, string>();

function messageFingerprint(message: object): string {
  // SSE DTOs are immutable; cache fingerprints so the previous delta is not serialized again.
  const cached = messageFingerprintCache.get(message);
  if (cached !== undefined) return cached;
  const fingerprint = JSON.stringify(message);
  messageFingerprintCache.set(message, fingerprint);
  return fingerprint;
}

/**
 * Keep a timeline row mounted while a streamed message receives its persisted
 * entry id. Part ids are derived before that id is assigned and remain stable.
 */
export function messageRenderKey(message: UiMessage): string {
  const firstPartId = message.parts[0]?.id;
  return firstPartId ? `part:${firstPartId}` : `message:${message.id}`;
}

/** Remove duplicate rows left when a streamed id changes to its persisted id. */
export function dedupeUiMessages(messages: UiMessage[]): UiMessage[] {
  if (messages.length < 2) return messages;
  const result: UiMessage[] = [];
  const indexByRenderKey = new Map<string, number>();
  let changed = false;
  for (const message of messages) {
    const key = messageRenderKey(message);
    const existing = indexByRenderKey.get(key);
    if (existing === undefined) {
      indexByRenderKey.set(key, result.length);
      result.push(message);
    } else {
      result[existing] = message;
      changed = true;
    }
  }
  return changed ? result : messages;
}

/**
 * Reuse previous list item references when content is unchanged so
 * memoized rows and scroll contentKey stay stable across SSE floods.
 */
export function stabilizeIdentifiedList<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (next.length === 0) return next;
  if (prev.length === 0) return next;
  const prevById = new Map(prev.map((message) => [message.id, message]));
  let changed = prev.length !== next.length;
  const out = next.map((message, index) => {
    const old = prevById.get(message.id);
    if (!old) {
      changed = true;
      return message;
    }
    if (old === message || messageFingerprint(old) === messageFingerprint(message)) {
      if (prev[index] !== old) changed = true;
      return old;
    }
    changed = true;
    return message;
  });
  return changed ? out : prev;
}

/**
 * Reuse previous message object references when content is unchanged so
 * memoized PartView rows skip re-render during SSE floods.
 */
export function stabilizeUiMessages(prev: UiMessage[], next: UiMessage[]): UiMessage[] {
  return stabilizeIdentifiedList(prev, next);
}

/** Upsert the one message carried by a high-frequency SSE delta. */
export function upsertUiMessage(prev: UiMessage[], next: UiMessage): UiMessage[] {
  const lastIndex = prev.length - 1;
  let existingIndex = prev[lastIndex]?.id === next.id ? lastIndex : -1;
  if (existingIndex < 0) {
    const renderKey = messageRenderKey(next);
    existingIndex = prev.findIndex(
      (message) => message.id === next.id || messageRenderKey(message) === renderKey,
    );
  }
  if (existingIndex < 0) return [...prev, next];
  const existing = prev[existingIndex]!;
  if (existing === next || messageFingerprint(existing) === messageFingerprint(next)) return prev;
  const result = prev.slice();
  result[existingIndex] = next;
  return result;
}
