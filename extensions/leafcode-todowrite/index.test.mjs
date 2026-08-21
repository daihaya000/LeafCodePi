import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTodos } from "./state.ts";

test("accepts the todowrite-discipline statuses and priority", () => {
  const result = normalizeTodos([
    { content: "調査", status: "completed", priority: "high" },
    { content: "実装", status: "in_progress", priority: "medium" },
    { content: "検証", status: "pending", priority: "low" },
  ]);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.todos.map((todo) => todo.id), ["todo-1", "todo-2", "todo-3"]);
});

test("rejects more than one in-progress item without changing the previous list", () => {
  const previous = [{ id: "todo-1", content: "前の作業", status: "pending", priority: "high" }];
  const result = normalizeTodos(
    [
      { content: "A", status: "in_progress", priority: "high" },
      { content: "B", status: "in_progress", priority: "low" },
    ],
    previous,
  );
  assert.match(result.error ?? "", /同時に1件/);
  assert.deepEqual(result.todos, previous);
});

test("preserves ids by content when the model omits ids", () => {
  const previous = [{ id: "build", content: "ビルド", status: "pending", priority: "medium" }];
  const result = normalizeTodos(
    [{ content: "ビルド", status: "completed", priority: "medium" }],
    previous,
  );
  assert.equal(result.todos[0].id, "build");
});
