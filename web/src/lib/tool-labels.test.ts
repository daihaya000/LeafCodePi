import { describe, expect, it } from "vitest";
import { toolInputFields, toolLabel, toolSummary } from "./tool-labels";

describe("toolLabel", () => {
  it("maps pi tools to Japanese labels", () => {
    expect(toolLabel("bash")).toBe("コマンド");
    expect(toolLabel("read")).toBe("読取");
    expect(toolLabel("edit")).toBe("編集");
    expect(toolLabel("todowrite")).toBe("ToDo");
    expect(toolLabel("grep")).toBe("検索");
    expect(toolLabel("ls")).toBe("一覧");
    expect(toolLabel("subagent")).toBe("サブエージェント");
  });

  it("keeps unknown tool names as-is", () => {
    expect(toolLabel("mcp__x__y")).toBe("mcp__x__y");
  });
});

describe("toolSummary", () => {
  it("ignores a title that only repeats the tool name", () => {
    expect(
      toolSummary("bash", { status: "running", title: "bash", input: { command: "ls -la" } }),
    ).toBe("ls -la");
  });

  it("prefers a real title", () => {
    expect(toolSummary("bash", { status: "running", title: "依存を導入" })).toBe("依存を導入");
  });

  it("uses path for file tools and pattern for search", () => {
    expect(toolSummary("read", { status: "completed", input: { path: "src/a.ts" } })).toBe(
      "src/a.ts",
    );
    expect(toolSummary("grep", { status: "completed", input: { pattern: "foo" } })).toBe("foo");
  });

  it("summarizes todo progress", () => {
    expect(
      toolSummary("todowrite", {
        status: "completed",
        input: { todos: [{ status: "completed" }, { status: "pending" }] },
      }),
    ).toBe("1/2 件");
  });

  it("falls back to the tool name", () => {
    expect(toolSummary("weird", { status: "completed" })).toBe("weird");
  });
});

describe("toolInputFields", () => {
  it("labels bash fields", () => {
    expect(toolInputFields("bash", { command: "ls", description: "一覧" })).toEqual([
      { label: "説明", value: "一覧" },
      { label: "コマンド", value: "ls" },
    ]);
  });

  it("renders todo entries as lines", () => {
    expect(
      toolInputFields("todowrite", {
        todos: [{ status: "pending", content: "A" }, { status: "completed", content: "B" }],
      }),
    ).toEqual([{ label: "ToDo", value: "pending A\ncompleted B" }]);
  });

  it("returns nothing without input", () => {
    expect(toolInputFields("read", undefined)).toEqual([]);
  });
});
