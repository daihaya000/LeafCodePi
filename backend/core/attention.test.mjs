import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionItemForTask, resolveAttentionSource } from "./attention.mjs";

test("a non-Bot task is always its own attention key", () => {
  assert.equal(resolveAttentionSource({ taskId: "task-1", isBotTask: false }), "task-1");
  assert.equal(
    resolveAttentionSource({ taskId: "task-1", isBotTask: false, delegated: [{ taskId: "code-1", requestId: "r1" }] }),
    "task-1",
    "a Code task never routes to a delegated session",
  );
});

test("a Bot task keeps its own request and otherwise uses the delegated owner", () => {
  const delegated = [{ taskId: "code-1", requestId: "r1" }, { taskId: "code-2", requestId: "r2" }];
  assert.equal(resolveAttentionSource({ taskId: "bot:b1", isBotTask: true, ownRequestId: "own" }), "bot:b1");
  assert.equal(resolveAttentionSource({ taskId: "bot:b1", isBotTask: true, delegated }), "code-1", "the first delegated owner, not the first started session");
  assert.equal(resolveAttentionSource({ taskId: "bot:b1", isBotTask: true, requestId: "r2", delegated }), "code-2");
  assert.equal(resolveAttentionSource({ taskId: "bot:b1", isBotTask: true, requestId: "own", ownRequestId: "own", delegated }), "bot:b1");
  assert.equal(resolveAttentionSource({ taskId: "bot:b1", isBotTask: true, requestId: "unknown", delegated }), "bot:b1", "an unknown request id keeps the Bot key");
});

test("a Bot task with nothing waiting stays on its own key", () => {
  assert.equal(resolveAttentionSource({ taskId: "bot:b1", isBotTask: true }), "bot:b1");
  assert.equal(resolveAttentionSource({ taskId: "bot:b1", isBotTask: true, delegated: [] }), "bot:b1");
  assert.equal(resolveAttentionSource({ taskId: "bot:b1", isBotTask: true, delegated: [{ taskId: "code-1" }] }), "bot:b1");
  assert.equal(resolveAttentionSource({ taskId: "bot:b1", isBotTask: true, delegated: [{ taskId: "code-1", requestId: null }] }), "bot:b1");
});

test("only an explicit true marks a Bot task", () => {
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(
      resolveAttentionSource({ taskId: "bot:b1", isBotTask: value, delegated: [{ taskId: "code-1", requestId: "r1" }] }),
      "bot:b1",
      String(value),
    );
  }
});

test("an attention item lists its kinds in the documented order", () => {
  assert.deepEqual(attentionItemForTask({ taskId: "t", title: "T", hasPermission: true, hasQuestion: true }), {
    taskId: "t", title: "T", kinds: ["permission", "question"],
  });
  assert.deepEqual(attentionItemForTask({ taskId: "t", title: "T", hasPermission: false, hasQuestion: true }), {
    taskId: "t", title: "T", kinds: ["question"],
  });
  assert.deepEqual(attentionItemForTask({ taskId: "t", title: "T", hasPermission: true, hasQuestion: false }), {
    taskId: "t", title: "T", kinds: ["permission"],
  });
});

test("nothing waiting means no item, and the origin is only present when known", () => {
  assert.equal(attentionItemForTask({ taskId: "t", title: "T", hasPermission: false, hasQuestion: false }), null);
  assert.equal(attentionItemForTask({ taskId: "t", title: "T", hasPermission: undefined, hasQuestion: undefined }), null);
  assert.deepEqual(
    attentionItemForTask({ taskId: "code-1", title: "T", hasPermission: true, hasQuestion: false, originTaskId: "bot:b1" }),
    { taskId: "code-1", title: "T", kinds: ["permission"], originTaskId: "bot:b1" },
  );
  assert.equal(
    "originTaskId" in attentionItemForTask({ taskId: "t", title: "T", hasPermission: true, hasQuestion: false, originTaskId: undefined }),
    false,
  );
});
