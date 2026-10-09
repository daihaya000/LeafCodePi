import assert from "node:assert/strict";
import test from "node:test";
import {
  clampTaskMessagePageSize,
  InvalidTaskMessageCursorError,
  MAX_TASK_MESSAGE_PAGE_SIZE,
  MIN_TASK_MESSAGE_PAGE_SIZE,
  pageTaskMessages,
  TASK_MESSAGE_PAGE_SIZE,
} from "./task-history.mjs";

test("page size is clamped and invalid values use the default", () => {
  assert.equal(clampTaskMessagePageSize(200), 200);
  assert.equal(clampTaskMessagePageSize("300"), 300);
  assert.equal(clampTaskMessagePageSize(1), MIN_TASK_MESSAGE_PAGE_SIZE);
  assert.equal(clampTaskMessagePageSize(10 ** 9), MAX_TASK_MESSAGE_PAGE_SIZE);
  assert.equal(clampTaskMessagePageSize(Number.NaN), TASK_MESSAGE_PAGE_SIZE);
  assert.equal(clampTaskMessagePageSize(""), TASK_MESSAGE_PAGE_SIZE);
  assert.equal(clampTaskMessagePageSize(undefined), TASK_MESSAGE_PAGE_SIZE);
});

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

test("long single turns stay bounded and remain navigable across all older pages", () => {
  const messages = [{ id: "user", role: "user" }, ...Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}`, role: "assistant" }))];
  let cursor, pages = [], count = 0;
  do {
    const page = pageTaskMessages(messages, cursor, 150);
    assert.ok(page.messages.length <= 300);
    pages = [...page.messages, ...pages];
    cursor = page.messageHistory.nextCursor;
    assert.ok(++count < 20);
  } while (cursor);
  assert.deepEqual(pages, messages);
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
