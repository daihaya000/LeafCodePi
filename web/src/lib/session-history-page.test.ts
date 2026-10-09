import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readSessionHistoryPage } from "@backend-runtime/lib/session-history-page";
import { snapshotMessages } from "@backend-runtime/lib/pi/snapshot-messages";
import { pageTaskMessages } from "@shared/task-history.mjs";
import { stripImageDataFromMessages } from "@shared/task-history-content.mjs";
import { resetSessionLogIndex, sessionLogIndexDiagnostics } from "@backend-core/session-log-index.mjs";
const roots: string[] = [];
const timestamp = "2026-10-09T00:00:00Z";
const user = (text: string) => ({ type: "message", message: { role: "user", content: text, timestamp: 1 } });
const assistant = (text: string, extra = {}) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 2, ...extra } });
function setup(rows: any[]) {
  resetSessionLogIndex(); const root = mkdtempSync(join(tmpdir(), "history-page-")); roots.push(root); const file = join(root, "session.jsonl");
  const entries = rows.map((row, i) => ({ id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp, ...row }));
  writeFileSync(file, [{ type: "session", version: 3, id: "session", timestamp, cwd: root }, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const manager = SessionManager.open(file);
  const session = { messages: manager.buildSessionContext().messages, sessionManager: manager, agent: { state: {} } } as unknown as Parameters<typeof snapshotMessages>[0];
  return { file, manager, entries, expected: snapshotMessages(session) };
}
afterEach(() => { resetSessionLogIndex(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("indexed cold history projection", () => {
  it("matches SDK history across tool pairs, compaction, UTF-8 and all page boundaries", async () => {
    const { file, manager, expected } = setup([
      user("original 日本語😀"), assistant("decision", { content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } }] }),
      { type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result" }], timestamp: 3 } },
      user("active goal"), assistant("verbatim recent tail"),
      { type: "compaction", firstKeptEntryId: "e3", summary: "old decision summary", tokensBefore: 100 },
      user("continue"), assistant("latest"),
    ]);
    const bytes = readFileSync(file);
    for (const cursor of [null, "e6", "e3", "e0"]) {
      const page = await readSessionHistoryPage(file, cursor, 2);
      expect(page).toEqual(pageTaskMessages(expected, cursor, 2));
    }
    const projection = JSON.stringify(manager.buildSessionContext().messages);
    expect(projection).toContain("old decision summary"); expect(projection).toContain("verbatim recent tail"); expect(projection).not.toContain("original 日本語");
    expect(readFileSync(file)).toEqual(bytes);
    const before = sessionLogIndexDiagnostics(); await readSessionHistoryPage(file, null, 2);
    expect(sessionLogIndexDiagnostics().scannedBytes).toBe(before.scannedBytes);
  });
  it("preserves hidden Goal Loop/intercom/persona state and stable part IDs", async () => {
    const { file, expected } = setup([
      user("start"), assistant("before persona change"),
      { type: "custom_message", customType: "leafcode-pi.agent-switch", content: "switch", details: { previousAgent: "old", nextAgent: "new" } },
      { type: "custom_message", customType: "leafcode-goal-verification", content: "hidden", details: { turn: 2, kind: "verification", goalId: "g" } },
      assistant("first verification"), assistant("second verification"),
      { type: "custom_message", customType: "intercom_message", content: "private", details: { from: { name: "peer" } } },
      assistant("reply peer"), assistant("peer tail"), user("manual"), assistant("manual reply"),
    ]);
    for (const cursor of [null, "e9", "e8", "e5", "e1"]) expect(await readSessionHistoryPage(file, cursor, 1)).toEqual(pageTaskMessages(expected, cursor, 1));
  });
  it("uses global ordinals when message.id is absent or not a string", async () => {
    const { file, expected } = setup([user("older"), user("recent"), assistant("tail", { id: 7 })]);
    expect(await readSessionHistoryPage(file, null, 1)).toEqual(pageTaskMessages(expected, null, 1));
  });
  it("normalizes cursor whitespace exactly like live history", async () => {
    const { file, expected } = setup([user("old"), user("recent"), assistant("tail")]);
    expect(await readSessionHistoryPage(file, " e1 ", 1)).toEqual(pageTaskMessages(expected, " e1 ", 1));
  });
  it("preserves part IDs for prototype-like persisted entry IDs", async () => {
    const { file, expected } = setup([{ ...user("old"), id: "root" }, { ...user("recent"), id: "__proto__", parentId: "root" }, { ...assistant("tail"), id: "constructor", parentId: "__proto__" }]);
    expect(await readSessionHistoryPage(file, null, 1)).toEqual(pageTaskMessages(expected, null, 1));
  });
  it("preserves images as lazy placeholders without retaining base64 in the projector", async () => {
    const { file, expected } = setup([user("old"), { type: "message", message: { role: "user", timestamp: 4, content: [{ type: "text", text: "image" }, { type: "image", mimeType: "image/png", data: "AAAA" }] } }, assistant("tail")]);
    expect(await readSessionHistoryPage(file, null, 3)).toEqual({ ...pageTaskMessages(expected, null, 3), messages: stripImageDataFromMessages(expected) });
  });
  it("does not hydrate hidden markers when the page before the first message is empty", async () => {
    const { file } = setup([{ type: "custom_message", customType: "leafcode-pi.agent-switch", content: "switch", details: { previousAgent: "old", nextAgent: "new" } }, user("first"), assistant("tail")]);
    await readSessionHistoryPage(file, null, 2); const before = sessionLogIndexDiagnostics();
    expect(await readSessionHistoryPage(file, "e1", 2)).toEqual({ messages: [], messageHistory: { hasMore: false, nextCursor: null } });
    const after = sessionLogIndexDiagnostics(); expect(after.parsedRows).toBe(before.parsedRows); expect(after.selectedBytes).toBe(before.selectedBytes);
  });
  it("restores selected throughput and rejects other-branch cursors", async () => {
    const { file } = setup([
      user("old"), assistant("answer", { timestamp: 1000 }),
      { type: "custom", customType: "leafcode-pi.throughput", data: { startedAtMs: 1000, firstTokenAtMs: 1100, lastTokenAtMs: 2100, outputTokens: 11 } },
      user("next"), assistant("tail", { timestamp: 3000 }),
    ]);
    const page = await readSessionHistoryPage(file, "e3", 2);
    expect(page.messages[1]).toMatchObject({ id: "e1", tokensPerSecond: 10, responseDurationMs: 1100 });
    await expect(readSessionHistoryPage(file, "other", 2)).rejects.toThrow("履歴カーソルが無効");
    const before = sessionLogIndexDiagnostics(); await readSessionHistoryPage(file, null, 2); expect(sessionLogIndexDiagnostics().scannedBytes).toBe(before.scannedBytes);
  });
});
