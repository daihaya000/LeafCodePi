import type { TaskMessageHistory, UiMessage } from "./types.js";

export const TASK_MESSAGE_PAGE_SIZE: number;
export class InvalidTaskMessageCursorError extends Error {
  constructor();
}
export function pageTaskMessages(
  messages: readonly UiMessage[],
  before?: string | null,
  limit?: number,
): { messages: UiMessage[]; messageHistory: TaskMessageHistory };
