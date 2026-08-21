import { describe, expect, it } from "vitest";
import { todosFromPiMessages } from "./todowrite-state";

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
});
