import type { UiMessage, UiPart } from "@/lib/types";

function partFingerprint(part: UiPart): string {
  if (part.type === "text" || part.type === "thinking") {
    return `${part.type}:${part.id}:${part.text.length}:${part.text.slice(-48)}`;
  }
  if (part.type === "image") {
    return `${part.type}:${part.id}:${part.url.length}`;
  }
  const state = part.state;
  return `${part.type}:${part.id}:${part.tool}:${state.status}:${state.output?.length ?? 0}:${state.error?.length ?? 0}:${state.startedAtMs ?? ""}:${state.endedAtMs ?? ""}`;
}

function messageFingerprint(message: UiMessage): string {
  return [
    message.id,
    message.role,
    message.error ?? "",
    message.outputTokens ?? "",
    message.tokensPerSecond ?? "",
    message.tokensPerSecondDecode ? "1" : "0",
    message.parts.map(partFingerprint).join("|"),
  ].join("#");
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
