import { existsSync, readFileSync, statSync } from "node:fs";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import {
  conversationFromPiMessages,
  type ConversationMessage,
} from "@/lib/direct-generation-text";

const MAX_SESSION_FILE_BYTES = 4_000_000;
/** 会話キャッシュの上限。超過時は最も古いエントリから追い出す（Map は挿入順）。 */
const CONVERSATION_CACHE_MAX_ENTRIES = 128;

type SessionConversationCacheEntry = {
  mtimeMs: number;
  size: number;
  conversation: ConversationMessage[];
};

const conversationCache = new Map<string, SessionConversationCacheEntry>();

function cacheConversation(
  sessionFile: string,
  entry: SessionConversationCacheEntry,
): void {
  if (
    conversationCache.size >= CONVERSATION_CACHE_MAX_ENTRIES &&
    !conversationCache.has(sessionFile)
  ) {
    const oldest = conversationCache.keys().next().value;
    if (oldest !== undefined) conversationCache.delete(oldest);
  }
  conversationCache.set(sessionFile, entry);
}

/** Read a persisted Pi session without opening a writable SessionManager. */
export function readSessionConversation(sessionFile: string | null | undefined): ConversationMessage[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  try {
    const stats = statSync(sessionFile);
    if (!stats.isFile() || stats.size > MAX_SESSION_FILE_BYTES) return [];
    const cached = conversationCache.get(sessionFile);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.conversation;
    }
    const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter((entry) => entry.type !== "session");
    const conversation = conversationFromPiMessages(buildSessionContext(sessionEntries).messages);
    cacheConversation(sessionFile, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      conversation,
    });
    return conversation;
  } catch {
    conversationCache.delete(sessionFile);
    return [];
  }
}
