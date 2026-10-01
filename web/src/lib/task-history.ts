import type { TaskMessageHistory, UiMessage } from "./types";
import { dedupeUiMessages, messageRenderKey, stabilizeIdentifiedList } from "./stabilize-messages";

import { InvalidTaskMessageCursorError, pageTaskMessages } from "@shared/task-history.mjs";
export { InvalidTaskMessageCursorError, pageTaskMessages, TASK_MESSAGE_PAGE_SIZE } from "@shared/task-history.mjs";

export const EMPTY_TASK_MESSAGE_HISTORY: TaskMessageHistory = {
  hasMore: false,
  nextCursor: null,
};

/** Preserve a Backend page marker; older Backends return full history without one. */
export function pageTaskDetailMessages(
  detail: { messages?: unknown; messageHistory?: unknown } | null | undefined,
  before?: string | null,
): ReturnType<typeof pageTaskMessages> {
  const messages = Array.isArray(detail?.messages) ? detail.messages as UiMessage[] : [];
  const history = detail?.messageHistory as Partial<TaskMessageHistory> | null | undefined;
  if (history && typeof history.hasMore === "boolean"
    && (history.nextCursor === null || typeof history.nextCursor === "string")) {
    return { messages, messageHistory: { hasMore: history.hasMore, nextCursor: history.nextCursor } };
  }
  return pageTaskMessages(messages, before);
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
  const diagnostics = { hasCrossKeyCollision: false };
  const deduped = dedupeUiMessages([...leading, ...trailing], diagnostics);
  // Cross-key matches can leave two rows with the same id after the first pass.
  return stabilizeIdentifiedList(
    current,
    diagnostics.hasCrossKeyCollision ? dedupeUiMessages(deduped) : deduped,
  );
}
