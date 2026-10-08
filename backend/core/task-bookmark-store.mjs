import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isStableMessageId } from "../../shared/task-search.mjs";
import { assertConfigurationOwner } from "./configuration-command.mjs";
import { withFileLock } from "./file-lock.mjs";

export const MAX_BOOKMARKS_PER_TASK = 500;
export const MAX_BOOKMARK_PREVIEW_CHARS = 200;

// Task ids become JSON object keys only (never paths), but stay restricted to the id alphabet.
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const emptyData = () => ({ version: 1, tasks: {} });

function failure(message, status) {
  return Object.assign(new Error(message), { status });
}

/** Whether `id` can address a task's bookmarks. */
export function isBookmarkTaskId(id) {
  return typeof id === "string" && TASK_ID.test(id);
}

function truncatePreview(value) {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  const characters = Array.from(text);
  return characters.length > MAX_BOOKMARK_PREVIEW_CHARS
    ? `${characters.slice(0, MAX_BOOKMARK_PREVIEW_CHARS - 1).join("")}…`
    : text;
}

/** A well-formed bookmark, or null for anything that cannot be one. */
function parseBookmark(value, fallbackCreatedAt) {
  if (!value || typeof value !== "object") return null;
  const { messageId, role, messageCreatedAt, createdAt, preview } = value;
  if (!isStableMessageId(messageId) || (role !== "user" && role !== "assistant")) return null;
  const timestamp = (candidate, fallback) =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? Math.trunc(candidate) : fallback;
  return {
    messageId,
    role,
    messageCreatedAt: timestamp(messageCreatedAt, 0),
    createdAt: timestamp(createdAt, fallbackCreatedAt),
    preview: truncatePreview(preview),
  };
}

const byTimeline = (a, b) =>
  a.messageCreatedAt - b.messageCreatedAt || a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId);

/**
 * Per-task message bookmarks in one JSON file (`{ version, tasks: { [taskId]: Bookmark[] } }`).
 * Reads never lock (the file is replaced atomically); writes serialize through the shared file lock so
 * a second WebUI process cannot lose an update. Messages are addressed by persisted entry id.
 */
export class TaskBookmarkStore {
  constructor({ filePath, now = () => Date.now(), onCorrupt = (error) => process.emitWarning(error) }) {
    this.filePath = filePath;
    this.now = now;
    this.onCorrupt = onCorrupt;
  }

  /**
   * `corrupt` is set when the file's content cannot be interpreted; reads then see an empty store.
   * Any other failure to read (a sharing violation, permissions) throws so a write never replaces
   * data that merely could not be read.
   */
  #read() {
    const file = this.filePath();
    let raw;
    try { raw = readFileSync(file, "utf8"); }
    catch (error) {
      if (error?.code === "ENOENT") return { data: emptyData(), corrupt: false };
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || !parsed.tasks || typeof parsed.tasks !== "object" || Array.isArray(parsed.tasks)) {
        return { data: emptyData(), corrupt: true };
      }
      const data = emptyData();
      for (const [taskId, entries] of Object.entries(parsed.tasks)) {
        if (!isBookmarkTaskId(taskId) || !Array.isArray(entries)) continue;
        const seen = new Set();
        const list = [];
        for (const entry of entries) {
          const bookmark = parseBookmark(entry, 0);
          if (!bookmark || seen.has(bookmark.messageId)) continue;
          seen.add(bookmark.messageId);
          list.push(bookmark);
        }
        if (list.length > 0) data.tasks[taskId] = list.sort(byTimeline).slice(0, MAX_BOOKMARKS_PER_TASK);
      }
      return { data, corrupt: false };
    } catch {
      return { data: emptyData(), corrupt: true };
    }
  }

  #write(data) {
    const file = this.filePath();
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  }

  /** Run `update(data)` under the file lock; it returns `{ result, changed }`. */
  #mutate(update) {
    assertConfigurationOwner();
    const file = this.filePath();
    return withFileLock(file, () => {
      const { data, corrupt } = this.#read();
      if (corrupt) {
        // Keep what was there: an unreadable file is more likely a bad write than worthless data.
        try { copyFileSync(file, `${file}.corrupt-${this.now()}`); }
        catch (error) { this.onCorrupt(new Error(`task bookmark file backup failed: ${file}`, { cause: error })); }
      }
      const { result, changed } = update(data);
      if (changed || corrupt) this.#write(data);
      return structuredClone(result);
    });
  }

  /** The task's bookmarks in timeline order. */
  list(taskId) {
    if (!isBookmarkTaskId(taskId)) return [];
    try { return structuredClone(this.#read().data.tasks[taskId] ?? []); }
    catch { return []; }
  }

  /**
   * Add a bookmark (a message that is already bookmarked keeps its first entry). `knownTaskIds`, when
   * non-empty, prunes the bookmarks of tasks that no longer exist.
   */
  add(taskId, input, { knownTaskIds } = {}) {
    if (!isBookmarkTaskId(taskId)) throw failure("タスクIDが不正です", 400);
    const bookmark = parseBookmark(input, this.now());
    if (!bookmark) throw failure("ブックマークできないメッセージです", 400);
    bookmark.createdAt = this.now();
    return this.#mutate((data) => {
      let changed = false;
      const list = data.tasks[taskId] ?? [];
      if (!list.some((entry) => entry.messageId === bookmark.messageId)) {
        if (list.length >= MAX_BOOKMARKS_PER_TASK) {
          throw failure(`ブックマークは1セッション${MAX_BOOKMARKS_PER_TASK}件までです`, 409);
        }
        data.tasks[taskId] = [...list, bookmark].sort(byTimeline);
        changed = true;
      }
      if (knownTaskIds && knownTaskIds.size > 0) {
        for (const id of Object.keys(data.tasks)) {
          if (id === taskId || knownTaskIds.has(id)) continue;
          delete data.tasks[id];
          changed = true;
        }
      }
      return { result: data.tasks[taskId] ?? [], changed };
    });
  }

  /** Remove one bookmark; removing one that does not exist is not an error. */
  remove(taskId, messageId) {
    if (!isBookmarkTaskId(taskId)) throw failure("タスクIDが不正です", 400);
    return this.#mutate((data) => {
      const list = data.tasks[taskId] ?? [];
      const next = list.filter((entry) => entry.messageId !== messageId);
      if (next.length === list.length) return { result: list, changed: false };
      if (next.length === 0) delete data.tasks[taskId];
      else data.tasks[taskId] = next;
      return { result: next, changed: true };
    });
  }
}
