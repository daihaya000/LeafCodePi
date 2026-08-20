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
});
