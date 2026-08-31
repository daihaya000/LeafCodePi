import { existsSync } from "node:fs";
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
  const database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 2_000 });
  try {
    const hasTable = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'",
    ).get();
    if (!hasTable) return [];

    // ponytail: a bounded LIKE scan keeps literal queries predictable; switch to the extension's FTS pipeline only if user-search latency becomes measurable.
    const matches = terms.map(() => "m.content LIKE ? ESCAPE '\\'").join(" OR ");
    const rows = database.prepare(`
      SELECT m.project, m.target, m.category, m.content, m.created, m.last_referenced
      FROM memories m
      WHERE ${matches}
      ORDER BY CASE WHEN m.content LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
               m.last_referenced DESC
      LIMIT ?
    `).all(...terms.map(likePattern), likePattern(normalized), MAX_RESULTS) as MemoryRow[];

    return rows.map((row) => ({
      project: row.project,
      target: row.target,
      category: row.category,
      content: row.content,
      created: row.created,
      lastReferenced: row.last_referenced,
    }));
  } finally {
    database.close();
  }
}
