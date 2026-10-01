export const TASK_MESSAGE_PAGE_SIZE = 50;

export class InvalidTaskMessageCursorError extends Error {
  constructor() {
    super("履歴カーソルが無効です");
    this.name = "InvalidTaskMessageCursorError";
  }
}

/** Return the newest page, or the page immediately before a known message. */
export function pageTaskMessages(messages, before, limit = TASK_MESSAGE_PAGE_SIZE) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : TASK_MESSAGE_PAGE_SIZE;
  const cursor = before?.trim() || null;
  let end = messages.length;
  if (cursor) {
    // Projected message ids are unique; older-page cursors usually sit near the tail.
    end = messages.findLastIndex((message) => message.id === cursor);
    if (end < 0) throw new InvalidTaskMessageCursorError();
  }
  let start = Math.max(0, end - safeLimit);
  if (start > 0 && messages[start]?.role !== "user") {
    // Keep the load-more boundary between turns rather than inside an assistant reply.
    for (let index = start - 1; index >= 0; index--) {
      if (messages[index]?.role === "user") {
        start = index;
        break;
      }
    }
  }
  const page = messages.slice(start, end);
  return {
    messages: page,
    messageHistory: {
      hasMore: start > 0,
      nextCursor: start > 0 ? page[0]?.id ?? null : null,
    },
  };
}
