import { describe, expect, it } from "vitest";
import { projectPiMessages, titleFromPrompt } from "./messages";

describe("titleFromPrompt", () => {
  it("uses the first non-empty line", () => {
    expect(titleFromPrompt("\n  修正して\n詳細")).toBe("修正して");
  });

  it("truncates long titles", () => {
    const title = titleFromPrompt("あ".repeat(80));
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBe(60);
  });
});

describe("projectPiMessages", () => {
  it("merges tool results into the assistant tool part", () => {
    const messages = projectPiMessages([
      { role: "user", content: "ls して", timestamp: 1, id: "u1" },
      {
        role: "assistant",
        id: "a1",
        timestamp: 2,
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        content: [
          { type: "text", text: "確認します" },
          { type: "toolCall", id: "call1", name: "ls", arguments: { path: "." } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call1",
        toolName: "ls",
        content: [{ type: "text", text: "package.json" }],
        isError: false,
      },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    const tool = messages[1].parts.find((part) => part.type === "tool");
    expect(tool?.type === "tool" && tool.state.status).toBe("completed");
    expect(tool?.type === "tool" && tool.state.output).toBe("package.json");
  });

  it("projects compaction summaries", () => {
    const messages = projectPiMessages([
      {
        role: "compactionSummary",
        id: "c1",
        timestamp: 10,
        summary: "以前の会話の要約",
        tokensBefore: 42_000,
      },
      { role: "user", content: "続き", timestamp: 11, id: "u2" },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "compaction",
      tokensBefore: 42_000,
    });
    expect(messages[0]?.parts[0]).toEqual({
      id: "c1-text",
      type: "text",
      text: "以前の会話の要約",
    });
    expect(messages[1]?.role).toBe("user");
  });

  it("projects assistant usage.output", () => {
    const messages = projectPiMessages([
      {
        role: "assistant",
        id: "a2",
        timestamp: 3,
        model: "local",
        provider: "llama-server",
        content: [{ type: "text", text: "ok" }],
        usage: { output: 42, input: 10, totalTokens: 52 },
      },
    ]);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      outputTokens: 42,
    });
  });
});
