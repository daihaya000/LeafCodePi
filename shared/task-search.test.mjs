import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SEARCH_HIT_LIMIT,
  MAX_SEARCH_HIT_LIMIT,
  clampSearchHitLimit,
  isStableMessageId,
  searchTaskMessages,
  searchableMessageText,
} from "./task-search.mjs";

const text = (id, role, body, createdAt = 1) => ({
  id,
  role,
  createdAt,
  parts: [{ id: `${id}-text`, type: "text", text: body }],
});

test("only persisted entry ids are stable addresses", () => {
  assert.equal(isStableMessageId("0a1b2c3d"), true);
  assert.equal(isStableMessageId("msg-12"), false);
  assert.equal(isStableMessageId(""), false);
  assert.equal(isStableMessageId(undefined), false);
  assert.equal(isStableMessageId("x".repeat(257)), false);
});

test("only user and assistant text counts as conversation text", () => {
  const assistant = {
    id: "a",
    role: "assistant",
    createdAt: 1,
    parts: [
      { id: "1", type: "thinking", text: "secret thought" },
      { id: "2", type: "text", text: "first" },
      { id: "3", type: "tool", tool: "bash", callID: "c", state: { status: "completed", output: "tool output" } },
      { id: "4", type: "text", text: "second" },
    ],
  };
  assert.equal(searchableMessageText(assistant), "first\nsecond");
  assert.equal(searchableMessageText({ role: "compaction", parts: [{ id: "x", type: "text", text: "summary" }] }), "");
  assert.equal(searchableMessageText(null), "");
});

test("hits keep timeline order and carry a highlighted snippet and the match count", () => {
  const messages = [
    text("u1", "user", "エラーが出ます。Error log を見て", 10),
    text("a1", "assistant", "原因は設定です", 20),
    text("a2", "assistant", "error と ERROR と Error", 30),
  ];
  const result = searchTaskMessages(messages, "ERROR");
  assert.equal(result.total, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.hits.map((hit) => [hit.messageId, hit.role, hit.createdAt, hit.count]), [
    ["u1", "user", 10, 1],
    ["a2", "assistant", 30, 3],
  ]);
  const [first] = result.hits;
  assert.deepEqual(first.highlights.map(([from, to]) => first.snippet.slice(from, to)), ["Error"]);
});

test("every term must match, across the parts of one message, and width is ignored", () => {
  const message = {
    id: "a1",
    role: "assistant",
    createdAt: 1,
    parts: [
      { id: "p1", type: "text", text: "設定ファイルを開く" },
      { id: "p2", type: "text", text: "ＡＢＣ を保存" },
    ],
  };
  assert.equal(searchTaskMessages([message], "設定 abc").total, 1);
  assert.equal(searchTaskMessages([message], "設定 xyz").total, 0);
  assert.equal(searchTaskMessages([message], '"設定ファイル"').total, 1);
  assert.equal(searchTaskMessages([message], "").total, 0);
});

test("unpersisted, hidden and non-conversation messages are skipped", () => {
  const messages = [
    text("msg-3", "assistant", "needle streaming tail"),
    text("retry", "user", "needle hang retry"),
    { id: "tool", role: "assistant", createdAt: 1, parts: [{ id: "t", type: "tool", tool: "bash", callID: "c", state: { status: "completed", output: "needle" } }] },
    text("ok", "user", "needle visible"),
  ];
  const result = searchTaskMessages(messages, "needle", { isHidden: (message) => message.id === "retry" });
  assert.deepEqual(result.hits.map((hit) => hit.messageId), ["ok"]);
});

test("a long result list keeps the newest hits and reports the full total", () => {
  const messages = Array.from({ length: 12 }, (_, index) => text(`m${index}`, "user", `needle ${index}`, index));
  const result = searchTaskMessages(messages, "needle", { limit: 5 });
  assert.equal(result.total, 12);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.hits.map((hit) => hit.messageId), ["m7", "m8", "m9", "m10", "m11"]);
});

test("the hit limit is clamped", () => {
  assert.equal(clampSearchHitLimit(undefined), DEFAULT_SEARCH_HIT_LIMIT);
  assert.equal(clampSearchHitLimit("abc"), DEFAULT_SEARCH_HIT_LIMIT);
  assert.equal(clampSearchHitLimit(0), 1);
  assert.equal(clampSearchHitLimit(10 ** 6), MAX_SEARCH_HIT_LIMIT);
  assert.equal(clampSearchHitLimit("25"), 25);
});
