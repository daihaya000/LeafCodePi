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
import { toolLabel, toolSummary } from "@/lib/tool-labels";

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

export type SessionWorkSummaryTodo = { content: string; status: string };
export type SessionWorkSummary = {
  todos: SessionWorkSummaryTodo[];
  activity: string[];
};

const WORK_SUMMARY_MAX_TODOS = 100;
const WORK_SUMMARY_MAX_ACTIVITIES = 30;
const WORK_SUMMARY_LINE_MAX_CHARS = 160;

/**
 * タイトル生成のフォールバック用。圧縮直後・履歴退避などで会話コンテキストが
 * 空になっても、生エントリから最新の ToDo スナップショットとツール実行ログを拾う。
 * 呼び出しは会話が取れなかった時だけなのでキャッシュは持たない。
 */
export function readSessionWorkSummary(sessionFile: string | null | undefined): SessionWorkSummary {
  const empty: SessionWorkSummary = { todos: [], activity: [] };
  if (!sessionFile || !existsSync(sessionFile)) return empty;
  try {
    const stats = statSync(sessionFile);
    if (!stats.isFile() || stats.size > MAX_SESSION_FILE_BYTES) return empty;
    const entries: unknown[] = parseSessionEntries(readFileSync(sessionFile, "utf8"));
    migrateSessionEntries(entries as Parameters<typeof migrateSessionEntries>[0]);
    let todos: SessionWorkSummaryTodo[] = [];
    const activity: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (record.type !== "message") continue;
      const message = (
        typeof record.message === "object" && record.message !== null ? record.message : record
      ) as Record<string, unknown>;
      if (message.role === "toolResult" && message.toolName === "todowrite") {
        const details =
          typeof message.details === "object" && message.details !== null
            ? message.details as Record<string, unknown>
            : null;
        const list = Array.isArray(details?.todos) ? details.todos : [];
        todos = list
          .flatMap((item) => {
            if (typeof item !== "object" || item === null) return [];
            const todo = item as Record<string, unknown>;
            const content = typeof todo.content === "string" ? todo.content.trim() : "";
            const status = typeof todo.status === "string" ? todo.status : "pending";
            return content ? [{ content, status }] : [];
          })
          .slice(0, WORK_SUMMARY_MAX_TODOS);
        continue;
      }
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (typeof part !== "object" || part === null) continue;
        const call = part as Record<string, unknown>;
        if (call.type !== "toolCall" || typeof call.name !== "string" || call.name === "todowrite") {
          continue;
        }
        const input =
          typeof call.arguments === "object" && call.arguments !== null
            ? call.arguments as Record<string, unknown>
            : undefined;
        const summary = toolSummary(call.name, { status: "completed", ...(input ? { input } : {}) });
        const label = toolLabel(call.name, input);
        const line = summary && summary !== call.name ? `${label}: ${summary}` : label;
        activity.push(
          line.length > WORK_SUMMARY_LINE_MAX_CHARS
            ? `${line.slice(0, WORK_SUMMARY_LINE_MAX_CHARS)}…`
            : line,
        );
      }
    }
    return { todos, activity: activity.slice(-WORK_SUMMARY_MAX_ACTIVITIES) };
  } catch {
    return empty;
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
 * 圧縮直後は buildSessionContext が（圧縮後の発言がまだ無いため）空になる。サイドバーの
 * プレビューは履歴の有無をそのまま表す必要があるため、生エントリからも末尾の発言を拾う。
 */
function lastMessageFromRawEntries(entries: unknown[]): SessionLastMessage | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "message") continue;
    const message = (typeof record.message === "object" && record.message !== null ? record.message : record) as Record<string, unknown>;
    const role = message.role;
    if (typeof role !== "string" || !LAST_MESSAGE_ROLES.has(role)) continue;
    if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) continue;
    return {
      role: role as SessionLastMessage["role"],
      text: role === "bashExecution" ? "" : textFromPiContent(message.content).trim(),
      timestamp: message.timestamp,
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
    const last = lastMessageFromEntries(buildSessionContext(sessionEntries).messages) ?? lastMessageFromRawEntries(sessionEntries);
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
