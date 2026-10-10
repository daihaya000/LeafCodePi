import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SESSION_LOAD_BYTES } from "@backend-core/session-memory-guard.mjs";
import { restoreOriginalUiHistory } from "@backend-runtime/lib/pi/original-ui-history";
import { snapshotMessages } from "@backend-runtime/lib/pi/snapshot-messages";
import { readSessionHistoryMessageIds, readSessionHistoryPage, searchSessionHistory } from "@backend-runtime/lib/session-history-page";
import { pageTaskMessages } from "@backend-runtime/lib/task-history";
import { resetSessionLogIndex } from "@backend-core/session-log-index.mjs";
import type { TaskDetail } from "@/lib/types";
vi.mock("@backend-runtime/lib/pi/history-page-size", () => ({ readHistoryPageSize: () => 2 }));
const roots: string[] = [];
afterEach(() => { resetSessionLogIndex(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "original-ui-history-")); roots.push(root);
  const file = join(root, "session.jsonl");
  const rows = [
    { type: "message", id: "old-user", parentId: null, message: { role: "user", content: "older request", timestamp: 1 } },
    { type: "message", id: "bookmark", parentId: "old-user", message: { role: "assistant", content: [{ type: "text", text: "original bookmarked decision" }], timestamp: 2 } },
    { type: "message", id: "current", parentId: "bookmark", message: { role: "user", content: "current request", timestamp: 3 } },
    { type: "compaction", id: "compact", parentId: "current", firstKeptEntryId: "current", summary: "summary", tokensBefore: 10 },
    { type: "message", id: "answer", parentId: "compact", message: { role: "assistant", content: [{ type: "text", text: "latest reply" }], timestamp: 4 } },
  ].map((row) => ({ timestamp: "2026-10-10T00:00:00Z", ...row }));
  writeFileSync(file, [{ type: "session", version: 3, id: "s", cwd: root }, ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const fd = openSync(file, "a"), padding = Buffer.alloc(1024 * 1024, 10);
  try { for (let i = 0; i < 65; i++) writeSync(fd, padding); } finally { closeSync(fd); }
  expect(statSync(file).size).toBeGreaterThan(MAX_SESSION_LOAD_BYTES);
  return { file, rows };
}
describe("original UI history for memory-slimmed sessions", () => {
  it("restores a bounded original page, keeps an unpersisted tail and pages to an older bookmark", async () => {
    const { file } = fixture(), size = statSync(file).size;
    const tail = { id: "msg-5", role: "assistant", createdAt: 5, parts: [{ id: "stream", type: "text", text: "streaming" }] };
    const detail = { id: "task", sessionFile: file, isStreaming: true, messageRevision: "live:old", messages: [tail] } as TaskDetail;
    const restored = await restoreOriginalUiHistory(detail);
    expect(restored.messages.map((row) => row.id)).toEqual(["current", "compact", "answer", "msg-5"]);
    expect(restored.messages.at(-1)).toEqual(tail);
    expect(restored.isStreaming).toBe(true);
    expect(pageTaskMessages(restored.messages, null, 20).messageHistory).toEqual({ hasMore: true, nextCursor: "current" });
    const older = await readSessionHistoryPage(file, "current", 2);
    expect(older.messages.find((row) => row.id === "bookmark")?.parts[0]).toMatchObject({ text: "original bookmarked decision" });
    expect(await readSessionHistoryMessageIds(file, ["bookmark", "gone"])).toEqual(new Set(["bookmark"]));
    const search = await searchSessionHistory(file, "bookmarked", 1);
    expect(search).toMatchObject({ total: 1, truncated: false, hits: [{ messageId: "bookmark", snippet: "original bookmarked decision" }] });
    expect(statSync(file).size).toBe(size);
    expect(await restoreOriginalUiHistory(detail, false)).toMatchObject({ messageRevision: "live:old:original-ui-v1", messages: [tail] });
  }, 20_000);
  it("does not emit load-only placeholders or shortened tool results in live snapshots", () => {
    const rows = [
      { type: "message", id: "old", message: { role: "assistant", content: [{ type: "text", text: "[older history automatically compacted in memory]" }], timestamp: 1 } },
      { type: "message", id: "tool-owner", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }], timestamp: 2 } },
      { type: "message", id: "tool-result", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "shortened" }], timestamp: 3 } },
      { type: "message", id: "current", message: { role: "user", content: "current request", timestamp: 4 } },
    ];
    const session = { messages: [], agent: { state: {} }, sessionManager: {
      getBranch: () => rows, getLeafId: () => "current", memoryOmittedEntryIds: new Set(["old", "tool-result"]),
    } } as unknown as Parameters<typeof snapshotMessages>[0];
    const messages = snapshotMessages(session);
    expect(messages.map((row) => row.id)).toEqual(["current"]);
    expect(snapshotMessages(session)).toBe(messages);
    expect(pageTaskMessages(messages).messageHistory).toEqual({ hasMore: true, nextCursor: "current" });
  });
});
