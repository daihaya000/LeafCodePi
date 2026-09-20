import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import {
  conversationFromPiMessages,
  type ConversationMessage,
} from "@/lib/direct-generation-text";
import { stripPromptMarkers } from "@/lib/pi/messages";
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

/**
 * 大きなセッションファイル向けの末尾読みサイズ。長いセッションは
 * MAX_SESSION_FILE_BYTES (4MB) を容易に超えるため、会話は末尾ウィンドウだけを読む
 *（タイトル生成に必要なのは最新の文脈だけ）。
 */
const TAIL_READ_BYTES = 4_000_000;
/** サイドバープレビュー用の末尾読みサイズ。最新1件だけ必要なので小さくする。 */
const LAST_MESSAGE_TAIL_BYTES = 1_000_000;
/** ToDo 救済の前方スキャン上限。これを超えるファイルは末尾ウィンドウだけで探す。 */
const LARGE_FILE_SCAN_MAX_BYTES = 64_000_000;
/** 末尾窓に会話が無い時（巨大な1行で窓が埋まる等）の再試行サイズ。 */
const LARGE_TAIL_RETRY_BYTES = 16_000_000;

/** 末尾 maxBytes だけを読む。先頭の部分行は捨てる。失敗時は null。 */
function readTailText(sessionFile: string, maxBytes: number): string | null {
  let fd = -1;
  try {
    fd = openSync(sessionFile, "r");
    const size = fstatSync(fd).size;
    if (!Number.isFinite(size) || size <= 0) return "";
    const count = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(count);
    readSync(fd, buffer, 0, count, size - count);
    let text = buffer.toString("utf8");
    if (count < size) {
      const newlineIndex = text.indexOf("\n");
      if (newlineIndex === -1) return "";
      text = text.slice(newlineIndex + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

type MigratedEntries = ReturnType<typeof parseSessionEntries>;

function parseAndMigrateEntries(content: string): MigratedEntries {
  const entries = parseSessionEntries(content);
  migrateSessionEntries(entries);
  return entries;
}

function contextConversation(entries: MigratedEntries): ConversationMessage[] {
  const sessionEntries = entries.filter((entry) => entry.type !== "session");
  return conversationFromPiMessages(buildSessionContext(sessionEntries).messages);
}

/** 大きなファイルの会話を末尾ウィンドウから読む。巨大な1行で窓が埋まる場合だけ広げる。 */
function readLargeConversation(sessionFile: string): ConversationMessage[] {
  for (const windowBytes of [TAIL_READ_BYTES, LARGE_TAIL_RETRY_BYTES]) {
    const text = readTailText(sessionFile, windowBytes);
    if (text === null) return [];
    if (!text.trim()) continue;
    const conversation = contextConversation(parseAndMigrateEntries(text));
    if (conversation.length > 0) return conversation;
  }
  return [];
}

/** Read a persisted Pi session without opening a writable SessionManager. */
export function readSessionConversation(sessionFile: string | null | undefined): ConversationMessage[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  try {
    const stats = statSync(sessionFile);
    if (!stats.isFile()) return [];
    const cached = conversationCache.get(sessionFile);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.conversation;
    }
    // 長いセッションは4MBを容易に超える。タイトルに必要なのは最新の文脈だけなので末尾だけ読む。
    const conversation =
      stats.size <= MAX_SESSION_FILE_BYTES
        ? contextConversation(parseAndMigrateEntries(readFileSync(sessionFile, "utf8")))
        : readLargeConversation(sessionFile);
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
    if (!stats.isFile()) return empty;
    if (stats.size <= MAX_SESSION_FILE_BYTES) {
      return summarizeWorkEntries(parseAndMigrateEntries(readFileSync(sessionFile, "utf8")));
    }
    return readLargeWorkSummary(sessionFile, stats.size);
  } catch {
    return empty;
  }
}

type WorkSummaryAccumulator = {
  todos: SessionWorkSummaryTodo[];
  activity: string[];
};

/** 生エントリ1件から最新の ToDo スナップショットとツール実行ログを拾う。 */
function observeWorkSummaryEntry(entry: unknown, state: WorkSummaryAccumulator): void {
  if (typeof entry !== "object" || entry === null) return;
  const record = entry as Record<string, unknown>;
  if (record.type !== "message") return;
  const message = (
    typeof record.message === "object" && record.message !== null ? record.message : record
  ) as Record<string, unknown>;
  if (message.role === "toolResult" && message.toolName === "todowrite") {
    const details =
      typeof message.details === "object" && message.details !== null
        ? message.details as Record<string, unknown>
        : null;
    const list = Array.isArray(details?.todos) ? details.todos : [];
    state.todos = list
      .flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const todo = item as Record<string, unknown>;
        const content = typeof todo.content === "string" ? todo.content.trim() : "";
        const status = typeof todo.status === "string" ? todo.status : "pending";
        return content ? [{ content, status }] : [];
      })
      .slice(0, WORK_SUMMARY_MAX_TODOS);
    return;
  }
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
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
    state.activity.push(
      line.length > WORK_SUMMARY_LINE_MAX_CHARS
        ? `${line.slice(0, WORK_SUMMARY_LINE_MAX_CHARS)}…`
        : line,
    );
  }
}

function summarizeWorkEntries(entries: readonly unknown[]): SessionWorkSummary {
  const state: WorkSummaryAccumulator = { todos: [], activity: [] };
  for (const entry of entries) observeWorkSummaryEntry(entry, state);
  return { todos: state.todos, activity: state.activity.slice(-WORK_SUMMARY_MAX_ACTIVITIES) };
}

/**
 * 大きなファイルの ToDo と作業ログを読む。作業ログは末尾窓、窓の外にある
 * 最新 ToDo は前方1パスで拾う（関係行だけ解析するので巨大ファイルでも有界）。
 */
function readLargeWorkSummary(sessionFile: string, size: number): SessionWorkSummary {
  const tailText = readTailText(sessionFile, TAIL_READ_BYTES);
  const tailSummary: SessionWorkSummary =
    tailText && tailText.trim()
      ? summarizeWorkEntries(parseAndMigrateEntries(tailText))
      : { todos: [], activity: [] };
  if (tailSummary.todos.length > 0 || size > LARGE_FILE_SCAN_MAX_BYTES) return tailSummary;
  const scanned = scanWorkSummary(sessionFile, size);
  return {
    todos: scanned.todos.length > 0 ? scanned.todos : tailSummary.todos,
    activity: tailSummary.activity.length > 0 ? tailSummary.activity : scanned.activity,
  };
}

/** 関係ない行（巨大なツール出力を含む）の JSON.parse を避ける事前フィルタ。 */
function observeWorkSummaryLine(line: string, state: WorkSummaryAccumulator): void {
  if (!line.includes('"type":"toolCall"') && !line.includes('"toolName":"todowrite"')) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  observeWorkSummaryEntry(entry, state);
}

/** 大きなファイルを先頭から1回だけ走査し、最新の ToDo と末尾の作業ログを集める。 */
function scanWorkSummary(sessionFile: string, size: number): SessionWorkSummary {
  const empty: SessionWorkSummary = { todos: [], activity: [] };
  let fd = -1;
  try {
    fd = openSync(sessionFile, "r");
    const decoder = new StringDecoder("utf8");
    const limit = Math.min(size, LARGE_FILE_SCAN_MAX_BYTES);
    const state: WorkSummaryAccumulator = { todos: [], activity: [] };
    let pending = "";
    let offset = 0;
    const CHUNK_BYTES = 1_000_000;
    while (offset < limit) {
      const count = Math.min(CHUNK_BYTES, limit - offset);
      const buffer = Buffer.allocUnsafe(count);
      const bytesRead = readSync(fd, buffer, 0, count, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        observeWorkSummaryLine(pending.slice(0, newlineIndex), state);
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    if (pending) observeWorkSummaryLine(pending, state);
    return { todos: state.todos, activity: state.activity.slice(-WORK_SUMMARY_MAX_ACTIVITIES) };
  } catch {
    return empty;
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
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
/** 最終発言キャッシュの上限。会話キャッシュと同じく超過時は最も古いエントリから追い出す。
 *  サイドバーはBot数ぶん読むため、会話(128)より余裕を持たせる。 */
const LAST_MESSAGE_CACHE_MAX_ENTRIES = 256;

function cacheLastMessage(sessionFile: string, entry: LastMessageCacheEntry): void {
  if (
    lastMessageCache.size >= LAST_MESSAGE_CACHE_MAX_ENTRIES &&
    !lastMessageCache.has(sessionFile)
  ) {
    const oldest = lastMessageCache.keys().next().value;
    if (oldest !== undefined) lastMessageCache.delete(oldest);
  }
  lastMessageCache.set(sessionFile, entry);
}
/** 最後の user/assistant/bashExecution を返す（bashExecution はテキスト空で時刻だけ意味を持つ）。 */
const LAST_MESSAGE_ROLES = new Set(["user", "assistant", "bashExecution"]);

function textFromPiContent(value: unknown): string {
  // プレビューに内部マーカー（ハング再送・Bot送信）を出さない。
  if (typeof value === "string") return stripPromptMarkers(value);
  if (!Array.isArray(value)) return "";
  return stripPromptMarkers(
    value
      .map((part) => {
        if (typeof part !== "object" || part === null) return "";
        const record = part as Record<string, unknown>;
        return record.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n"),
  );
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
    if (!stats.isFile()) return null;
    const cached = lastMessageCache.get(sessionFile);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.value;
    }
    // 長いセッションでもプレビューが出るよう、大きなファイルは末尾だけ読む
    const content =
      stats.size <= MAX_SESSION_FILE_BYTES
        ? readFileSync(sessionFile, "utf8")
        : readTailText(sessionFile, LAST_MESSAGE_TAIL_BYTES);
    if (content === null || !content.trim()) {
      cacheLastMessage(sessionFile, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        value: null,
      });
      return null;
    }
    const entries = parseAndMigrateEntries(content);
    const sessionEntries = entries.filter((entry) => entry.type !== "session");
    const last = lastMessageFromEntries(buildSessionContext(sessionEntries).messages) ?? lastMessageFromRawEntries(sessionEntries);
    cacheLastMessage(sessionFile, {
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
