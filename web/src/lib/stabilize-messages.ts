import type { UiMessage } from "@/lib/types";

const messageFingerprintCache = new WeakMap<UiMessage, string>();

function messageFingerprint(message: UiMessage): string {
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

/**
 * Reuse previous message object references when content is unchanged so
 * memoized PartView rows skip re-render during SSE floods.
 */
export function stabilizeUiMessages(prev: UiMessage[], next: UiMessage[]): UiMessage[] {
  if (next.length === 0) return next;
  if (prev.length === 0) return next;
  const prevById = new Map(prev.map((message) => [message.id, message]));
  let changed = prev.length !== next.length;
  const out = next.map((message) => {
    const old = prevById.get(message.id);
    if (!old) {
      changed = true;
      return message;
    }
    if (old === message || messageFingerprint(old) === messageFingerprint(message)) {
      return old;
    }
    changed = true;
    return message;
  });
  return changed ? out : prev;
}

/** Upsert the one message carried by a high-frequency SSE delta. */
export function upsertUiMessage(prev: UiMessage[], next: UiMessage): UiMessage[] {
  const lastIndex = prev.length - 1;
  const renderKey = messageRenderKey(next);
  const existingIndex = prev[lastIndex]?.id === next.id
    ? lastIndex
    : prev.findIndex(
        (message) => message.id === next.id || messageRenderKey(message) === renderKey,
      );
  if (existingIndex < 0) return [...prev, next];
  const existing = prev[existingIndex]!;
  if (existing === next || messageFingerprint(existing) === messageFingerprint(next)) return prev;
  const result = prev.slice();
  result[existingIndex] = next;
  return result;
}
