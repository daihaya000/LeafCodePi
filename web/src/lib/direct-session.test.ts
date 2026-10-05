import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionPreviewBudget,
  readSessionConversation,
  readSessionLastMessage,
  readSessionWorkSummary,
  SESSION_PREVIEW_POLL_BUDGET_BYTES,
  SESSION_PREVIEW_POLL_MAX_FILES,
  sessionPreviewReadCost,
} from "./direct-session";
import { BOT_PROMPT_PREFIX } from "./pi/messages";

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

  it("keeps internal prompt markers out of the preview text", () => {
    const file = tempFile(
      "bot-prompt.session",
      [
        entry({ type: "session", id: "s4", version: 1 }),
        message("m1", "user", `${BOT_PROMPT_PREFIX}Botからの依頼`, 1_700_000_000_000),
      ].join("\n"),
    );

    expect(readSessionLastMessage(file)).toEqual({
      role: "user",
      text: "Botからの依頼",
      timestamp: 1_700_000_000_000,
    });
  });
});

describe("readSessionWorkSummary", () => {
  const entry = (value: Record<string, unknown>) => JSON.stringify(value);

  it("extracts the latest ToDo snapshot and tool activity from raw entries", () => {
    const file = tempFile(
      "work-summary.session",
      [
        entry({ type: "session", id: "s1", version: 1 }),
        entry({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 } }),
        entry({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "a.ts" } }], timestamp: 2 } }),
        entry({ type: "message", id: "m3", message: { role: "toolResult", toolName: "todowrite", details: { todos: [{ id: "t1", content: "古いToDo", status: "completed", priority: "high" }] }, content: [], timestamp: 3 } }),
        entry({ type: "message", id: "m4", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "git status" } }], timestamp: 4 } }),
        entry({ type: "message", id: "m5", message: { role: "toolResult", toolName: "todowrite", details: { todos: [
          { id: "t1", content: "古いToDo", status: "completed", priority: "high" },
          { id: "t2", content: "新しいToDo", status: "in_progress", priority: "medium" },
        ] }, content: [], timestamp: 5 } }),
        entry({ type: "compaction", id: "c9", summary: "summary", tokensBefore: 999, timestamp: 6 }),
      ].join("\n"),
    );

    const summary = readSessionWorkSummary(file);

    expect(summary.todos).toEqual([
      { content: "古いToDo", status: "completed" },
      { content: "新しいToDo", status: "in_progress" },
    ]);
    expect(summary.activity).toEqual(["編集: a.ts", "コマンド: git status"]);
  });

  it("returns an empty summary for missing or broken session files", () => {
    expect(readSessionWorkSummary(null)).toEqual({ todos: [], activity: [] });
    expect(readSessionWorkSummary(join("C:", "no-such-file"))).toEqual({ todos: [], activity: [] });
    expect(readSessionWorkSummary(tempFile("broken-work.session", "{not json\n"))).toEqual({ todos: [], activity: [] });
  });
});

describe("large session files", () => {
  const entry = (value: Record<string, unknown>) => JSON.stringify(value);
  // 4MBガードを超えるための詰め物（巨大なツール出力1行を模す）
  const padding = "x".repeat(4_300_000);
  const toolResult = (id: string, parentId: string, toolName: string, extra: Record<string, unknown>, timestamp: number) =>
    entry({ type: "message", id, parentId, message: { role: "toolResult", toolName, content: [], timestamp, ...extra } });
  const userMessage = (id: string, parentId: string, text: string, timestamp: number) =>
    entry({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }], timestamp } });
  const assistantMessage = (id: string, parentId: string, text: string, timestamp: number) =>
    entry({ type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text }], timestamp } });

  it("reads conversation from the tail of a file over 4MB", () => {
    const file = tempFile(
      "large-conversation.session",
      [
        entry({ type: "session", id: "s9", version: 3 }),
        toolResult("pad", "s9", "bash", { content: [{ type: "text", text: padding }] }, 1),
        userMessage("m1", "pad", "末尾の質問", 2),
        assistantMessage("m2", "m1", "末尾の回答", 3),
      ].join("\n"),
    );

    const conversation = readSessionConversation(file);
    expect(conversation.length).toBeGreaterThan(0);
    expect(conversation[conversation.length - 1]).toEqual({ role: "assistant", text: "末尾の回答" });
  });

  it("finds head ToDo snapshot and tail activity in a file over 4MB", () => {
    const file = tempFile(
      "large-work-summary.session",
      [
        entry({ type: "session", id: "s9", version: 3 }),
        toolResult("todo", "s9", "todowrite", { details: { todos: [{ id: "t1", content: "先頭のToDo", status: "in_progress", priority: "high" }] } }, 1),
        toolResult("pad", "todo", "bash", { content: [{ type: "text", text: padding }] }, 2),
        entry({ type: "message", id: "m1", parentId: "pad", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "a.ts" } }], timestamp: 3 } }),
      ].join("\n"),
    );

    const summary = readSessionWorkSummary(file);
    expect(summary.todos).toEqual([{ content: "先頭のToDo", status: "in_progress" }]);
    expect(summary.activity).toEqual(["編集: a.ts"]);
  });

  it("reads the last message from the tail of a file over 4MB", () => {
    const file = tempFile(
      "large-last-message.session",
      [
        entry({ type: "session", id: "s9", version: 3 }),
        toolResult("pad", "s9", "bash", { content: [{ type: "text", text: padding }] }, 1),
        userMessage("m1", "pad", "末尾の発言", 2),
      ].join("\n"),
    );

    expect(readSessionLastMessage(file)).toEqual({ role: "user", text: "末尾の発言", timestamp: 2 });
  });

  it("reads the last message from a file just over the full-read limit", () => {
    // 512KB超・1MB未満: 全読みではなく1MBの末尾窓で足りる。
    const file = tempFile(
      "medium-last-message.session",
      [
        entry({ type: "session", id: "s9", version: 3 }),
        toolResult("pad", "s9", "bash", { content: [{ type: "text", text: "x".repeat(600_000) }] }, 1),
        userMessage("m1", "pad", "中くらいのセッションの発言", 2),
      ].join("\n"),
    );

    expect(readSessionLastMessage(file)).toEqual({ role: "user", text: "中くらいのセッションの発言", timestamp: 2 });
  });

  it("widens the tail window when one huge line fills it", () => {
    // 1MB窓を巨大な1行が埋めるので4MB窓まで広げて見つける。
    const file = tempFile(
      "huge-line-last-message.session",
      [
        entry({ type: "session", id: "s9", version: 3 }),
        userMessage("m1", "s9", "窓の外の重要な発言", 1),
        toolResult("pad", "m1", "bash", { content: [{ type: "text", text: "y".repeat(1_100_000) }] }, 2),
        assistantMessage("m2", "pad", "その後の発言", 3),
      ].join("\n"),
    );

    expect(readSessionLastMessage(file)).toEqual({ role: "assistant", text: "その後の発言", timestamp: 3 });
  });
});

describe("session preview poll budget", () => {
  const entry = (value: Record<string, unknown>) => JSON.stringify(value);
  const userMessage = (id: string, parentId: string, text: string, timestamp: number) =>
    entry({
      type: "message",
      id,
      parentId,
      message: { role: "user", content: [{ type: "text", text }], timestamp },
    });

  it("documents the hard poll caps", () => {
    expect(SESSION_PREVIEW_POLL_BUDGET_BYTES).toBe(8_000_000);
    expect(SESSION_PREVIEW_POLL_MAX_FILES).toBe(24);
  });

  it("charges the common-case read cost, not the rare 4MB widen", () => {
    expect(sessionPreviewReadCost(100_000)).toBe(100_000);
    expect(sessionPreviewReadCost(800_000)).toBe(800_000);
    expect(sessionPreviewReadCost(5_000_000)).toBe(1_000_000);
  });

  it("skips uncached reads once the byte budget is exhausted", () => {
    const file = tempFile(
      "budget.session",
      [
        entry({ type: "session", id: "s1", version: 1 }),
        userMessage("m1", "s1", "hello budget", 1),
      ].join("\n"),
    );
    const budget = createSessionPreviewBudget(1, 24);
    expect(readSessionLastMessage(file, budget)).toBeNull();
    expect(budget.remainingFiles).toBe(24);
    // Without a budget the same file still resolves.
    expect(readSessionLastMessage(file)?.text).toBe("hello budget");
  });

  it("skips further files once the file cap is hit", () => {
    const mk = (name: string) =>
      tempFile(
        name,
        [
          entry({ type: "session", id: name, version: 1 }),
          userMessage("m1", name, `msg-${name}`, 1),
        ].join("\n"),
      );
    const first = mk("a.session");
    const second = mk("b.session");
    const budget = createSessionPreviewBudget(8_000_000, 1);
    expect(readSessionLastMessage(first, budget)?.text).toBe("msg-a.session");
    expect(readSessionLastMessage(second, budget)).toBeNull();
    expect(budget.remainingFiles).toBe(0);
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