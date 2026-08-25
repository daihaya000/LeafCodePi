import { describe, expect, it } from "vitest";
import { findResumableTurn } from "../aborted-resume";
import {
  entryIdsForProjectedMessages,
  projectPiMessages,
  stripAnsiEscapeSequences,
  titleFromPrompt,
} from "./messages";

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
  it("keeps fallback ids aligned when projecting a streamed suffix", () => {
    const [message] = projectPiMessages(
      [{ role: "assistant", content: [{ type: "text", text: "続き" }] }],
      3,
    );

    expect(message?.id).toBe("msg-3");
    expect(message?.parts[0]?.id).toBe("msg-3-text-0");
  });

  it("removes ANSI escape sequences from tool output", () => {
    const colored = "\u001b[1m\u001b[32m✓ passed\u001b[39m\u001b[22m";
    const messages = projectPiMessages([
      {
        role: "assistant",
        id: "a-ansi",
        timestamp: 1,
        content: [{ type: "toolCall", id: "call-ansi", name: "bash", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-ansi",
        content: [{ type: "text", text: colored }],
        isError: false,
      },
      {
        role: "bashExecution",
        id: "b-ansi",
        timestamp: 2,
        command: "npm test",
        output: colored,
        exitCode: 0,
      },
    ]);

    expect(stripAnsiEscapeSequences(colored)).toBe("✓ passed");
    expect(messages[0]?.parts[0]).toMatchObject({
      type: "tool",
      state: { output: "✓ passed" },
    });
    expect(messages[1]?.parts[0]).toMatchObject({
      type: "tool",
      state: { output: "✓ passed" },
    });
  });

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
    // 応答時間は射影では作らない（Pi の assistant timestamp は生成開始時刻で、
    // 直前レコード差分は常に 0s になるため）。実測値は harness の
    // applyThroughput が throughput timing から注入する。
    expect(messages[1].responseDurationMs).toBeUndefined();
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
    // 応答時間は射影では付かない（throughput timing が無いメッセージは非表示）。
    expect(messages[0].responseDurationMs).toBeUndefined();
  });

  it("preserves Pi aborts as resumable turns after reload", () => {
    const messages = projectPiMessages([
      { role: "user", id: "u1", timestamp: 1, content: "続けて" },
      {
        role: "assistant",
        id: "a1",
        timestamp: 2,
        stopReason: "aborted",
        content: [],
      },
    ]);

    expect(messages[1]?.error).toBe("Aborted");
    expect(findResumableTurn(messages)).toMatchObject({
      reason: "aborted",
      messageId: "a1",
      text: "続けて",
    });
  });
});

describe("entryIdsForProjectedMessages", () => {
  it("skips toolResult entries so user message ids stay aligned", () => {
    const user1 = { role: "user", content: "ls して" };
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call1", name: "ls", arguments: {} }],
    };
    const toolResult = {
      role: "toolResult",
      toolCallId: "call1",
      content: [{ type: "text", text: "ok" }],
    };
    const user2 = { role: "user", content: "続き" };
    const stored = [user1, assistant, toolResult, user2];
    const entryIdByMessage = new Map<unknown, string>([
      [user1, "e-user-1"],
      [assistant, "e-assistant"],
      [toolResult, "e-tool-result"],
      [user2, "e-user-2"],
    ]);

    const projected = projectPiMessages(stored);
    const entryIds = entryIdsForProjectedMessages(stored, entryIdByMessage);

    expect(projected).toHaveLength(3);
    expect(entryIds).toEqual(["e-user-1", "e-assistant", "e-user-2"]);
    expect(
      projected.map((message, index) =>
        entryIds[index] ? { ...message, id: entryIds[index]! } : message,
      )[2],
    ).toMatchObject({ role: "user", id: "e-user-2" });
  });
});
