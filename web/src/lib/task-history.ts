import type { TaskMessageHistory, UiMessage } from "./types";
import { dedupeUiMessages, stabilizeUiMessages } from "./stabilize-messages";

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
    ...(payload.eventType === "revert" || payload.eventType === "unrevert"
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
