import type { TaskSearchResult, UiMessage } from "./types.js";

export const DEFAULT_SEARCH_HIT_LIMIT: number;
export const MAX_SEARCH_HIT_LIMIT: number;

/** Whether `id` is a persisted session entry id (stable across reloads). */
export function isStableMessageId(id: unknown): id is string;

/** The text a message shows as conversation: user and assistant text parts, nothing else. */
export function searchableMessageText(message: Pick<UiMessage, "role" | "parts"> | null | undefined): string;

export function clampSearchHitLimit(value: unknown): number;

/** Messages that contain every term of `query`, in timeline order (newest `limit` kept when truncated). */
export function searchTaskMessages(
  messages: readonly UiMessage[],
  query: unknown,
  options?: { limit?: number; isHidden?: (message: UiMessage) => boolean },
): TaskSearchResult;
