import type { TaskMessageHistory, UiMessage } from "./types.js";

export const TASK_MESSAGE_PAGE_SIZE: number;
export const MIN_TASK_MESSAGE_PAGE_SIZE: number;
export const MAX_TASK_MESSAGE_PAGE_SIZE: number;
export function clampTaskMessagePageSize(value: unknown): number;
export class InvalidTaskMessageCursorError extends Error {
  constructor();
}
export function pageTaskMessages(
  messages: readonly UiMessage[],
  before?: string | null,
  limit?: number,
): { messages: UiMessage[]; messageHistory: TaskMessageHistory };
