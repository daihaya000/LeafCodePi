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

export type SessionLastMessage = {
  role: "user" | "assistant" | "bashExecution";
  text: string;
  timestamp: number;
};

type LastMessageCacheEntry = {
  mtimeMs: number;
  size: number;
  value: SessionLastMessage | null;
};

const lastMessageCache = new Map<string, LastMessageCacheEntry>();
/** 最後の user/assistant/bashExecution を返す（bashExecution はテキスト空で時刻だけ意味を持つ）。 */
const LAST_MESSAGE_ROLES = new Set(["user", "assistant", "bashExecution"]);

function textFromPiContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function lastMessageFromEntries(sessionEntries: unknown[]): SessionLastMessage | null {
  for (let index = sessionEntries.length - 1; index >= 0; index -= 1) {
    const message = sessionEntries[index];
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    const role = record.role;
    if (typeof role !== "string" || !LAST_MESSAGE_ROLES.has(role)) continue;
    if (typeof record.timestamp !== "number" || !Number.isFinite(record.timestamp)) continue;
    return {
      role: role as SessionLastMessage["role"],
      text: role === "bashExecution" ? "" : textFromPiContent(record.content).trim(),
      timestamp: record.timestamp,
    };
  }
  return null;
}

/**
 * 最後の発言をセッションファイルから読む（サイドバープレビュー用）。
 * ランタイム初期化・Piセッション生成を伴わないため、Bot一覧の初回表示が
 * getTaskDetail（ensureLive）の 17 秒級のコールドを踏まない。
 */
export function readSessionLastMessage(sessionFile: string | null | undefined): SessionLastMessage | null {
  if (!sessionFile || !existsSync(sessionFile)) return null;
  try {
    const stats = statSync(sessionFile);
    if (!stats.isFile() || stats.size > MAX_SESSION_FILE_BYTES) return null;
    const cached = lastMessageCache.get(sessionFile);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.value;
    }
    const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter((entry) => entry.type !== "session");
    const last = lastMessageFromEntries(buildSessionContext(sessionEntries).messages);
    lastMessageCache.set(sessionFile, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      value: last,
    });
    return last;
  } catch {
    lastMessageCache.delete(sessionFile);
    return null;
  }
}
