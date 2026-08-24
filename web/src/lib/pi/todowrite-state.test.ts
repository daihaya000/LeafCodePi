import { describe, expect, it } from "vitest";
import { todoProgressFromTodos, todosFromPiMessages } from "./todowrite-state";

describe("todosFromPiMessages", () => {
  it("returns the latest todowrite snapshot", () => {
    expect(
      todosFromPiMessages([
        {
          role: "toolResult",
          toolName: "todowrite",
          details: {
            todos: [{ content: "古い状態", status: "pending", priority: "low" }],
          },
        },
        {
          role: "toolResult",
          toolName: "todowrite",
          details: {
            todos: [
              { id: "build", content: "実装", status: "in_progress", priority: "high" },
              { id: "test", content: "検証", status: "pending", priority: "medium" },
            ],
          },
        },
      ]),
    ).toEqual([
      { id: "build", content: "実装", status: "in_progress", priority: "high" },
      { id: "test", content: "検証", status: "pending", priority: "medium" },
    ]);
  });

  it("ignores malformed snapshots", () => {
    expect(
      todosFromPiMessages([
        {
          role: "toolResult",
          toolName: "todowrite",
          details: { todos: [{ content: "壊れた", status: "unknown", priority: "high" }] },
        },
      ]),
    ).toEqual([]);
  });

  it("counts completed and cancelled todos as finished", () => {
    expect(
      todoProgressFromTodos([
        { id: "done", content: "完了", status: "completed", priority: "low" },
        { id: "cancelled", content: "中止", status: "cancelled", priority: "low" },
        { id: "pending", content: "未完了", status: "pending", priority: "low" },
      ]),
    ).toEqual({ completed: 2, total: 3 });
  });
});
