import type { TaskMessageHistory, UiMessage } from "./types";
import { dedupeUiMessages, messageRenderKey, stabilizeUiMessages } from "./stabilize-messages";

export const TASK_MESSAGE_PAGE_SIZE = 50;

export const EMPTY_TASK_MESSAGE_HISTORY: TaskMessageHistory = {
  hasMore: false,
  nextCursor: null,
};

export class InvalidTaskMessageCursorError extends Error {
  constructor() {
    super("履歴カーソルが無効です");
    this.name = "InvalidTaskMessageCursorError";
  }
}

/** API clients expose invalid cursors as HTTP 409 errors. */
export function isInvalidTaskMessageCursorError(error: unknown): boolean {
  return (
    error instanceof InvalidTaskMessageCursorError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { status?: unknown }).status === 409)
  );
}

/** Keep a loaded-page cursor valid when a streamed message receives its persisted id. */
export function remapTaskMessageCursor(
  history: TaskMessageHistory,
  current: readonly UiMessage[],
  incoming: readonly UiMessage[],
): TaskMessageHistory {
  const cursor = history.nextCursor;
  if (!cursor) return history;
  const currentMessage = current.find((message) => message.id === cursor);
  if (!currentMessage) return history;
  const renderKey = messageRenderKey(currentMessage);
  const replacement = incoming.find((message) => messageRenderKey(message) === renderKey);
  if (!replacement || replacement.id === cursor) return history;
  return { ...history, nextCursor: replacement.id };
}

/** Return the newest page, or the page immediately before a known message. */
export function pageTaskMessages(
  messages: readonly UiMessage[],
  before?: string | null,
  limit = TASK_MESSAGE_PAGE_SIZE,
): { messages: UiMessage[]; messageHistory: TaskMessageHistory } {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : TASK_MESSAGE_PAGE_SIZE;
  const cursor = before?.trim() || null;
  let end = messages.length;
  if (cursor) {
    end = messages.findIndex((message) => message.id === cursor);
    if (end < 0) throw new InvalidTaskMessageCursorError();
  }
  const start = Math.max(0, end - safeLimit);
  const page = messages.slice(start, end);
  return {
    messages: page,
    messageHistory: {
      hasMore: start > 0,
      nextCursor: start > 0 ? page[0]?.id ?? null : null,
    },
  };
}

/** Page a live snapshot while preserving rewind markers for the client. */
export function pageTaskSnapshotPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.type !== "snapshot" || !Array.isArray(payload.messages)) return payload;
  const page = pageTaskMessages(payload.messages as UiMessage[]);
  return {
    ...payload,
    messages: page.messages,
    messageHistory: page.messageHistory,
    ...(payload.eventType === "revert" ||
      payload.eventType === "unrevert" ||
      payload.eventType === "conversation_reset"
      ? { historyReset: true }
      : {}),
  };
}

/** Merge a newer tail snapshot without discarding pages already loaded by the user. */
export function mergeNewerTaskMessages(
  current: UiMessage[],
  incoming: readonly UiMessage[],
): UiMessage[] {
  return mergeTaskMessages(current, current, incoming);
}

/** Prepend an older page while retaining the current live copy at the boundary. */
export function prependOlderTaskMessages(
  current: UiMessage[],
  incoming: readonly UiMessage[],
): UiMessage[] {
  return mergeTaskMessages(current, incoming, current);
}

function mergeTaskMessages(
  current: UiMessage[],
  leading: readonly UiMessage[],
  trailing: readonly UiMessage[] = [],
): UiMessage[] {
  return stabilizeUiMessages(current, dedupeUiMessages([...leading, ...trailing]));
}
