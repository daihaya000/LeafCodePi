import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionConversation, readSessionLastMessage } from "./direct-session";

const dirs: string[] = [];
function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "direct-session-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readSessionLastMessage", () => {
  const entry = (value: Record<string, unknown>) => JSON.stringify(value);
  const message = (id: string, role: string, content: string, timestamp: number) =>
    entry({ type: "message", id, message: { role, content: [{ type: "text", text: content }], timestamp } });

  it("skips tool results and compaction entries, returning the newest user/assistant message", () => {
    const file = tempFile(
      "compacted.session",
      [
        entry({ type: "session", id: "s1", version: 1 }),
        message("m1", "user", "first question", 1_700_000_000_000),
        message("m2", "assistant", "first answer", 1_700_000_001_000),
        entry({ type: "message", id: "m3", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }], timestamp: 1_700_000_002_000 } }),
        entry({ type: "compaction", id: "c1", summary: "summary of the prefix", tokensBefore: 12_345, timestamp: 1_700_000_003_000 }),
        message("m4", "assistant", "after the compaction", 1_700_000_004_000),
      ].join("\n"),
    );

    expect(readSessionLastMessage(file)).toEqual({ role: "assistant", text: "after the compaction", timestamp: 1_700_000_004_000 });
    // 2回目はキャッシュ経路でも同じ結果になる
    expect(readSessionLastMessage(file)).toEqual({ role: "assistant", text: "after the compaction", timestamp: 1_700_000_004_000 });
  });

  it("falls back to the newest real message when the session ends with a compaction entry", () => {
    const file = tempFile(
      "tail-compaction.session",
      [
        entry({ type: "session", id: "s2", version: 1 }),
        message("m1", "user", "only question", 1_700_000_000_000),
        entry({ type: "compaction", id: "c1", summary: "summary", tokensBefore: 999, timestamp: 1_700_000_001_000 }),
      ].join("\n"),
    );

    expect(readSessionLastMessage(file)).toEqual({ role: "user", text: "only question", timestamp: 1_700_000_000_000 });
  });

  it("returns null for a session without usable messages", () => {
    const file = tempFile("meta-only.session", `${JSON.stringify({ type: "session", id: "s3", version: 1 })}\n`);
    expect(readSessionLastMessage(file)).toBeNull();
    expect(readSessionLastMessage(null)).toBeNull();
  });
});

describe("readSessionConversation", () => {
  it("returns an empty conversation for missing or empty session files", () => {
    expect(readSessionConversation(null)).toEqual([]);
    expect(readSessionConversation(undefined)).toEqual([]);
    expect(readSessionConversation(join("C:", "no-such-file"))).toEqual([]);
    expect(readSessionConversation(tempFile("empty.session", ""))).toEqual([]);
  });

  it("tolerates malformed session files without throwing", () => {
    const file = tempFile("broken.session", "{not json\nlorem ipsum\n");
    expect(readSessionConversation(file)).toEqual([]);
    // キャッシュ経路（2回目）も同じ結果を返す
    expect(readSessionConversation(file)).toEqual([]);
  });

  it("caches a stable result across repeated reads", () => {
    // header（type: session）と未対応メッセージだけでも安全に空会話を返す
    const file = tempFile(
      "basic.session",
      `${JSON.stringify({ type: "session", id: "s1", version: 1 })}\n` +
        `${JSON.stringify({ type: "message", id: "m1", role: "user", text: "hello" })}\n`,
    );
    const first = readSessionConversation(file);
    const second = readSessionConversation(file);
    expect(Array.isArray(first)).toBe(true);
    expect(second).toEqual(first);
  });
});