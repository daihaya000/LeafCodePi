import { buildSnippet, findTermRanges, foldForSearch, parseSearchQuery } from "./text-search.mjs";

export const DEFAULT_SEARCH_HIT_LIMIT = 200;
export const MAX_SEARCH_HIT_LIMIT = 500;

// A streamed message that is not persisted yet is projected as `msg-<index>`; the persisted entry id
// replaces it later, so only the replacement is a stable address for search hits and bookmarks.
const UNPERSISTED_ID = /^msg-\d+$/;
const MAX_ID_CHARS = 256;

/** Whether `id` is a persisted session entry id (stable across reloads). */
export function isStableMessageId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_CHARS && !UNPERSISTED_ID.test(id);
}

/** The text a message shows as conversation: user and assistant text parts, nothing else. */
export function searchableMessageText(message) {
  if (!message || (message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.parts)) return "";
  let text = "";
  for (const part of message.parts) {
    if (part?.type !== "text" || typeof part.text !== "string" || part.text === "") continue;
    text += text === "" ? part.text : `\n${part.text}`;
  }
  return text;
}

/** Clamp a requested hit limit to [1, MAX_SEARCH_HIT_LIMIT]; anything else uses the default. */
export function clampSearchHitLimit(value) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return DEFAULT_SEARCH_HIT_LIMIT;
  return Math.min(MAX_SEARCH_HIT_LIMIT, Math.max(1, Math.round(number)));
}

/**
 * Messages that contain every term of `query`, in timeline order. `isHidden` drops messages the
 * timeline does not show (hang-retry prompts). When more than `limit` match, the newest are kept
 * and `truncated` is set; `total` always counts every match.
 */
export function searchTaskMessages(messages, query, { limit = DEFAULT_SEARCH_HIT_LIMIT, isHidden } = {}) {
  const terms = parseSearchQuery(query);
  if (terms.length === 0 || !Array.isArray(messages)) return { terms, total: 0, truncated: false, hits: [] };
  const hits = [];
  for (const message of messages) {
    if (!message || !isStableMessageId(message.id) || (isHidden && isHidden(message))) continue;
    const text = searchableMessageText(message);
    if (text === "") continue;
    const ranges = findTermRanges(foldForSearch(text), terms);
    if (!ranges) continue;
    const snippet = buildSnippet(text, ranges);
    hits.push({
      messageId: message.id,
      role: message.role,
      createdAt: Number.isFinite(message.createdAt) ? message.createdAt : 0,
      snippet: snippet.text,
      highlights: snippet.highlights,
      count: ranges.length,
    });
  }
  const capped = clampSearchHitLimit(limit);
  const truncated = hits.length > capped;
  return { terms, total: hits.length, truncated, hits: truncated ? hits.slice(hits.length - capped) : hits };
}
