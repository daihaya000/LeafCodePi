import type { UiMessage } from "@/lib/types";

/** Only transport/response failures can be reconciled; explicit owner rejections stay errors. */
export function isUnconfirmedPromptDelivery(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "BACKEND_FORWARD_FAILED" &&
    !("reason" in error && ["unauthorized", "incompatible", "not-configured"].includes(
      String((error as { reason?: unknown }).reason),
    ));
}

/** A remapped old message or a working status is not proof that this input was received. */
export function hasReceivedSubmittedPrompt(
  before: readonly UiMessage[],
  after: readonly UiMessage[],
  text: string,
): boolean {
  if (!text.trim()) return false;
  const ids = new Set(before.map((message) => message.id));
  const lastUserTime = before.reduce((latest, message) => (
    message.role === "user" && Number.isFinite(message.createdAt)
      ? Math.max(latest, message.createdAt)
      : latest
  ), -Infinity);
  return after.some((message) => (
    message.role === "user"
    && !ids.has(message.id)
    && Number.isFinite(message.createdAt)
    && message.createdAt > lastUserTime
    && message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n\n") === text
  ));
}

/** Optimistic echo id prefix; never sent to the server or stored in the transcript cache. */
export const OPTIMISTIC_USER_MESSAGE_PREFIX = "optimistic-user:";

/**
 * Local echo of a just-sent text prompt, shown until the owner's transcript carries the real row.
 * It bridges POST → Backend accept → session message_start → dirty wake → SSE, which can take a
 * noticeable moment (cold session, Auto routing, extension hooks) before anything else changes.
 */
export function optimisticUserMessage(text: string, createdAt: number): UiMessage {
  const id = `${OPTIMISTIC_USER_MESSAGE_PREFIX}${createdAt}`;
  return { id, role: "user", createdAt, parts: [{ id: `${id}:text`, type: "text", text }] };
}

/**
 * True once the transcript holds a user row that is newer than everything before the send.
 * Looser than `hasReceivedSubmittedPrompt` on purpose: the optimistic echo must never sit next to
 * the real row, even when the owner rewrote the text (skills, Auto routing, attachments).
 */
export function hasNewUserMessageSince(
  before: readonly UiMessage[],
  after: readonly UiMessage[],
): boolean {
  const ids = new Set(before.map((message) => message.id));
  const lastUserTime = before.reduce((latest, message) => (
    message.role === "user" && Number.isFinite(message.createdAt)
      ? Math.max(latest, message.createdAt)
      : latest
  ), -Infinity);
  return after.some((message) => (
    message.role === "user"
    && !message.hangRetry
    && !ids.has(message.id)
    && Number.isFinite(message.createdAt)
    && message.createdAt > lastUserTime
  ));
}
