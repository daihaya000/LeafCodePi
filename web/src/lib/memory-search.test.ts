import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_MEMORY_SEARCH_QUERY_LENGTH,
  searchLeafCodeMemory,
} from "@/lib/memory-search";

let agentDir = "";
let env: Record<string, string | undefined>;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "leafcode-memory-search-"));
  env = { PI_CODING_AGENT_DIR: agentDir };
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

function seedMemories() {
  const memoryDir = join(agentDir, "leafcode-memory");
  mkdirSync(memoryDir, { recursive: true });
  const database = new Database(join(memoryDir, "sessions.db"));
  database.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY,
      project TEXT,
      target TEXT NOT NULL,
      category TEXT,
      content TEXT NOT NULL,
      created TEXT NOT NULL,
      last_referenced TEXT NOT NULL
    );
  `);
  const insert = database.prepare(`
    INSERT INTO memories (project, target, category, content, created, last_referenced)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run(null, "memory", "convention", "deployment convention", "2026-01-01", "2026-01-01");
  insert.run("demo", "failure", "failure", "deployment failed despite the convention", "2026-02-01", "2026-02-01");
  insert.run(null, "memory", null, "CPU 50% threshold", "2026-03-01", "2026-03-01");
  database.close();
}

describe("searchLeafCodeMemory", () => {
  it("searches literal terms, ranks an exact phrase first, and preserves scope metadata", () => {
    seedMemories();

    const results = searchLeafCodeMemory("deployment convention", env);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      project: null,
      target: "memory",
      category: "convention",
      content: "deployment convention",
      lastReferenced: "2026-01-01",
    });
    expect(results[1]).toMatchObject({ project: "demo", target: "failure" });
    expect(searchLeafCodeMemory("%", env).map((entry) => entry.content)).toEqual(["CPU 50% threshold"]);
  });

  it("returns no results before the store exists and bounds query length", () => {
    expect(searchLeafCodeMemory("anything", env)).toEqual([]);
    expect(() => searchLeafCodeMemory("x".repeat(MAX_MEMORY_SEARCH_QUERY_LENGTH + 1), env)).toThrow(/200文字以内/);
  });
});
