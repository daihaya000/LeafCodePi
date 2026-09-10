import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionConversation } from "./direct-session";

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