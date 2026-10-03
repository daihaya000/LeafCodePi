import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { leafCodeMemoryDir } from "@/lib/leafcode-memory-settings";
import type { AgentsMdEnv } from "@/lib/agents-md";
import type { MemorySearchEntry } from "@/lib/leafcode-memory-schema";

export const MAX_MEMORY_SEARCH_QUERY_LENGTH = 200;
const MAX_SEARCH_TERMS = 12;
const MAX_RESULTS = 20;

type MemoryRow = {
  project: string | null;
  target: MemorySearchEntry["target"];
  category: MemorySearchEntry["category"];
  content: string;
  created: string;
  last_referenced: string;
};

type MemorySearchEntryDto = MemorySearchEntry;

/** Trigram tokens need three characters to match, so shorter queries stay on LIKE. */
const MIN_FTS_TERM_LENGTH = 3;

function toMemoryEntry(row: MemoryRow): MemorySearchEntryDto {
  return {
    project: row.project,
    target: row.target,
    category: row.category,
    content: row.content,
    created: row.created,
    lastReferenced: row.last_referenced,
  };
}

function hasMemoryFts(database: Database.Database): boolean {
  try {
    return Boolean(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'")
        .get(),
    );
  } catch {
    return false;
  }
}

/**
 * FTS-backed search: rows come back ranked by match count, so no full-table scan.
 * Returns null when the query cannot be expressed safely so the caller falls back.
 */
function searchWithFts(
  database: Database.Database,
  normalized: string,
  terms: readonly string[],
): MemoryRow[] | null {
  const tokens = terms.filter((term) => term.length >= MIN_FTS_TERM_LENGTH);
  if (tokens.length === 0) return null;
  try {
    return database
      .prepare(
        `SELECT m.project, m.target, m.category, m.content, m.created, m.last_referenced
         FROM memory_fts f
         JOIN memories m ON m.id = f.rowid
         WHERE memory_fts MATCH ?
         ORDER BY bm25(memory_fts), m.last_referenced DESC
         LIMIT ?`,
      )
      .all(`"${tokens.map((token) => token.replaceAll('"', '""')).join('" OR "')}"`, MAX_RESULTS) as MemoryRow[];
  } catch {
    // A malformed MATCH expression must not break the search.
    return null;
  }
}

/**
 * Read-only handles are cached per database file. Every search used to reopen the
 * SQLite file, which re-reads the schema and page cache on each call. The handle is
 * dropped when the file is replaced (new mtime/size stamp) and after a bounded idle
 * period, so a rotated database is never served from a stale handle.
 */
const DATABASE_IDLE_MS = 60_000;
const DATABASE_HANDLE_LIMIT = 4;
type CachedDatabase = { database: Database.Database; stamp: string; usedAt: number };
const databaseCache = new Map<string, CachedDatabase>();

function openReadonlyDatabase(databasePath: string): Database.Database {
  const stamp = databaseStamp(databasePath);
  const cached = databaseCache.get(databasePath);
  const now = Date.now();
  if (cached && cached.stamp === stamp && now - cached.usedAt < DATABASE_IDLE_MS) {
    cached.usedAt = now;
    return cached.database;
  }
  if (cached) closeCachedDatabase(databasePath);
  const database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 2_000 });
  if (databaseCache.size >= DATABASE_HANDLE_LIMIT) {
    const oldest = [...databaseCache.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
    if (oldest) closeCachedDatabase(oldest[0]);
  }
  databaseCache.set(databasePath, { database, stamp, usedAt: now });
  return database;
}

function databaseStamp(databasePath: string): string {
  try {
    const stats = statSync(databasePath);
    return `${stats.mtimeMs}:${stats.size}:${stats.ino}`;
  } catch {
    return "missing";
  }
}

function closeCachedDatabase(databasePath: string): void {
  const cached = databaseCache.get(databasePath);
  if (!cached) return;
  databaseCache.delete(databasePath);
  try {
    cached.database.close();
  } catch {
    // A handle that is already closed cannot fail the caller.
  }
}

/** Test-only: close every cached read-only handle. */
export function resetMemorySearchDatabaseCacheForTests(): void {
  for (const databasePath of [...databaseCache.keys()]) closeCachedDatabase(databasePath);
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

export function searchLeafCodeMemory(
  query: string,
  env: AgentsMdEnv = process.env,
): MemorySearchEntry[] {
  const normalized = query.trim();
  if (!normalized) return [];
  if (normalized.length > MAX_MEMORY_SEARCH_QUERY_LENGTH) {
    throw Object.assign(new Error(`検索語は${MAX_MEMORY_SEARCH_QUERY_LENGTH}文字以内で入力してください`), { status: 400 });
  }

  const databasePath = join(leafCodeMemoryDir(env), "sessions.db");
  if (!existsSync(databasePath)) return [];

  const terms = [...new Set(normalized.split(/\s+/u))].slice(0, MAX_SEARCH_TERMS);
  const database = openReadonlyDatabase(databasePath);
  const cached = databaseCache.get(databasePath);
  try {
    const hasTable = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'",
    ).get();
    if (!hasTable) return [];

    // memory_fts (fts5/trigram) already mirrors memories, so the substring scan can
    // use it instead of evaluating LIKE over every row. Fall back to LIKE when the
    // index is missing (older database) or a query is too short for a trigram.
    if (terms.length > 0 && normalized.length >= MIN_FTS_TERM_LENGTH && hasMemoryFts(database)) {
      const ftsRows = searchWithFts(database, normalized, terms);
      if (ftsRows) return ftsRows.map(toMemoryEntry);
    }

    // ponytail: a bounded LIKE scan keeps literal queries predictable; switch to the extension's FTS pipeline only if user-search latency becomes measurable.
    const matches = terms.map(() => "m.content LIKE ? ESCAPE '\\'").join(" OR ");
    // Recall stays OR; rank rows that contain the whole phrase first, then by how many terms matched.
    const hits = terms.map(() => "(CASE WHEN m.content LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)").join(" + ");
    const rows = database.prepare(`
      SELECT m.project, m.target, m.category, m.content, m.created, m.last_referenced
      FROM memories m
      WHERE ${matches}
      ORDER BY CASE WHEN m.content LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
               (${hits}) DESC,
               m.last_referenced DESC
      LIMIT ?
    `).all(
      ...terms.map(likePattern),
      likePattern(normalized),
      ...terms.map(likePattern),
      MAX_RESULTS,
    ) as MemoryRow[];

    return rows.map((row) => ({
      project: row.project,
      target: row.target,
      category: row.category,
      content: row.content,
      created: row.created,
      lastReferenced: row.last_referenced,
    }));
  } finally {
    // The handle is cached for the next search. Drop it when the file changed under
    // us, or when the query failed, so a broken handle cannot poison later searches.
    if (cached && (cached.stamp !== databaseStamp(databasePath) || !database.open)) {
      closeCachedDatabase(databasePath);
    }
  }
}
