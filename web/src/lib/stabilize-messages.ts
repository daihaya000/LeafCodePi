import type { UiMessage, UiPart } from "@/lib/types";

function partFingerprint(part: UiPart): string {
  if (part.type === "text" || part.type === "thinking") {
    return `${part.type}:${part.id}:${part.text.length}:${part.text.slice(-48)}`;
  }
  if (part.type === "image") {
    return `${part.type}:${part.id}:${part.url.length}`;
  }
  const state = part.state;
  return `${part.type}:${part.id}:${part.tool}:${state.status}:${state.output?.length ?? 0}:${state.output?.slice(-48) ?? ""}:${state.error?.length ?? 0}:${state.startedAtMs ?? ""}:${state.endedAtMs ?? ""}`;
}

function messageFingerprint(message: UiMessage): string {
  return [
    message.id,
    message.role,
    message.error ?? "",
    message.diagnostics ? JSON.stringify(message.diagnostics) : "",
    message.outputTokens ?? "",
    message.tokensPerSecond ?? "",
    message.tokensPerSecondDecode ? "1" : "0",
    message.parts.map(partFingerprint).join("|"),
  ].join("#");
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
