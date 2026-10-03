import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_MEMORY_SEARCH_QUERY_LENGTH,
  resetMemorySearchDatabaseCacheForTests,
  searchLeafCodeMemory,
} from "@/lib/memory-search";

let agentDir = "";
let env: Record<string, string | undefined>;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "leafcode-memory-search-"));
  env = { PI_CODING_AGENT_DIR: agentDir };
});

afterEach(() => {
  resetMemorySearchDatabaseCacheForTests();
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
  it("ranks rows matching more terms ahead of newer rows matching fewer", () => {
    seedMemories();
    const database = new Database(join(agentDir, "leafcode-memory", "sessions.db"));
    database.prepare("INSERT INTO memories (project, target, category, content, created, last_referenced) VALUES (?, ?, ?, ?, ?, ?)")
      .run(null, "memory", null, "failed convention note", "2026-04-01", "2026-04-01");
    database.close();

    const contents = searchLeafCodeMemory("failed deployment convention", env).map((row) => row.content);

    // Row 2 has all three terms; the newer row has only two and must come after it.
    expect(contents[0]).toBe("deployment failed despite the convention");
    expect(contents.indexOf("failed convention note")).toBeGreaterThan(0);
  });

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

  it("reuses the read-only handle across searches and reopens after the file changes", () => {
    seedMemories();
    const databasePath = join(agentDir, "leafcode-memory", "sessions.db");

    expect(searchLeafCodeMemory("deployment", env).length).toBeGreaterThan(0);
    // A second search must observe a row added after the first one, which only
    // works if the cached handle saw the new content or was reopened.
    const writer = new Database(databasePath);
    writer.prepare("INSERT INTO memories (project, target, category, content, created, last_referenced) VALUES (?, ?, ?, ?, ?, ?)")
      .run(null, "memory", null, "later deployment note", "2026-05-01", "2026-05-01");
    writer.close();

    const contents = searchLeafCodeMemory("deployment", env).map((row) => row.content);
    expect(contents).toContain("later deployment note");
  });
});
