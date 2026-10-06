import assert from "node:assert/strict";
import test from "node:test";
import { InvalidTaskMessageCursorError, pageTaskMessages } from "./task-history.mjs";

test("shared pagination preserves turn boundaries and older-page cursors", () => {
  const messages = [
    { id: "user-1", role: "user" },
    { id: "reply-1", role: "assistant" },
    { id: "user-2", role: "user" },
    { id: "reply-2", role: "assistant" },
    { id: "reply-3", role: "assistant" },
  ];
  const latest = pageTaskMessages(messages, null, 2);
  assert.deepEqual(latest.messages, messages.slice(2));
  assert.deepEqual(latest.messageHistory, { hasMore: true, nextCursor: "user-2" });
  assert.deepEqual(pageTaskMessages(messages, "user-2", 2).messages, messages.slice(0, 2));
  assert.throws(() => pageTaskMessages(messages, "missing"), InvalidTaskMessageCursorError);
});

test("latest-page transport excludes old history without mutating the source", (t) => {
  const messages = Array.from({ length: 5000 }, (_, index) => ({
    id: `m${index}`, role: "user", parts: [{ type: "text", text: "x".repeat(100) }],
  }));
  const page = pageTaskMessages(messages);
  const fullBytes = Buffer.byteLength(JSON.stringify({ messages }));
  const pageBytes = Buffer.byteLength(JSON.stringify(page));
  assert.equal(page.messages.length, 150);
  assert.equal(messages.length, 5000);
  assert.deepEqual(page.messageHistory, { hasMore: true, nextCursor: "m4850" });
  assert.ok(pageBytes < fullBytes / 25);
  t.diagnostic(`synthetic history JSON: full=${fullBytes} bytes, latest page=${pageBytes} bytes`);
});
