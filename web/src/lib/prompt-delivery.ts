import type { UiMessage } from "@/lib/types";

/** Only transport/response failures can be reconciled; explicit owner rejections stay errors. */
export function isUnconfirmedPromptDelivery(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const details = error as { status?: unknown; code?: unknown; reason?: unknown };
  if (details.status === 408 && details.reason === "timeout") return true;
  return details.code === "BACKEND_FORWARD_FAILED" &&
    !["unauthorized", "incompatible", "not-configured"].includes(String(details.reason));
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
export function optimisticUserMessage(
  text: string,
  createdAt: number,
  attachments: readonly OptimisticAttachment[] = [],
): UiMessage {
  const id = `${OPTIMISTIC_USER_MESSAGE_PREFIX}${createdAt}`;
  const parts: UiMessage["parts"] = [];
  if (text) parts.push({ id: `${id}:text`, type: "text", text });
  attachments.forEach((attachment, index) => {
    const partId = `${id}:attachment:${index}`;
    if (attachment.mime.toLowerCase().startsWith("image/")) {
      parts.push({ id: partId, type: "image", url: attachment.uri, mime: attachment.mime, ...(attachment.name ? { filename: attachment.name } : {}) });
    } else {
      parts.push({ id: partId, type: "file", name: attachment.name?.trim() || "attachment", mime: attachment.mime || "application/octet-stream" });
    }
  });
  return { id, role: "user", createdAt, parts };
}

/** Composer attachment as the echo needs it (data URI + mime); mirrors `ComposerAttachment`. */
export type OptimisticAttachment = { uri: string; mime: string; name?: string };

/** Image / file previews for Bot and Room echo bubbles (same split as `composerPromptAttachments`). */
export function optimisticAttachmentPreviews(createdAt: number, attachments: readonly OptimisticAttachment[]): {
  images: { key: string; src: string; alt?: string }[];
  files: { key: string; name: string; mime?: string }[];
} {
  const images: { key: string; src: string; alt?: string }[] = [];
  const files: { key: string; name: string; mime?: string }[] = [];
  attachments.forEach((attachment, index) => {
    const key = `${OPTIMISTIC_USER_MESSAGE_PREFIX}${createdAt}:${index}`;
    if (attachment.mime.toLowerCase().startsWith("image/")) images.push({ key, src: attachment.uri, ...(attachment.name ? { alt: attachment.name } : {}) });
    else files.push({ key, name: attachment.name?.trim() || "attachment", mime: attachment.mime || undefined });
  });
  return { images, files };
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

/**
 * Room transcripts are flat `role`/`id` rows (no hangRetry). True once a user id appears that was
 * not in the pre-send set — the optimistic Room bubble must yield as soon as POST/SSE lands it.
 */
export function hasNewRoomUserMessageSince(
  beforeUserIds: ReadonlySet<string>,
  after: readonly { id: string; role: string }[],
): boolean {
  return after.some((message) => message.role === "user" && !beforeUserIds.has(message.id));
}

/**
 * Whether the sticky WorkingRow should paint under the transcript.
 * Hide it only while the newest turn's assistant bubble is growing text at its tail — a streaming
 * caret covers that state; a second "作業中…" spinner feels like lag. A user row (or a pending echo)
 * after the last assistant means the new turn has not produced text yet, so the row must show:
 * walking back past it would find the previous turn's finished text and hide the indicator.
 */
export function shouldShowWorkingRow(
  working: boolean,
  messages: readonly UiMessage[],
  pendingEcho = false,
): boolean {
  if (!working) return false;
  if (pendingEcho) return true;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") return true;
    if (message.role !== "assistant") continue;
    return !isStreamingTextTail(message);
  }
  return true;
}

/** True when the message's last part is non-empty text and no tool is still running in it. */
export function isStreamingTextTail(message: UiMessage): boolean {
  if (message.role !== "assistant") return false;
  for (const part of message.parts) {
    if (part.type === "tool" && (part.state.status === "running" || part.state.status === "pending")) return false;
  }
  const last = message.parts.at(-1);
  return last?.type === "text" && last.text.length > 0;
}
