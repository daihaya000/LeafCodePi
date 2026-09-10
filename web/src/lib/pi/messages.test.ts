import { describe, expect, it } from "vitest";
import { findResumableTurn } from "../aborted-resume";
import {
  entryIdsForProjectedMessages,
  MAX_UI_TOOL_OUTPUT_CHARS,
  projectPiMessages,
  stripAnsiEscapeSequences,
  titleFromPrompt,
  truncateUiToolOutput,
  UI_TOOL_OUTPUT_OMISSION,
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

  it("does not split surrogate pairs when truncating", () => {
    const title = titleFromPrompt("🎉".repeat(80));
    // 壊れたサロゲートが残らない（絵文字59個＋…）
    expect(Array.from(title)).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("truncates tool output without splitting surrogate pairs", () => {
    const truncated = truncateUiToolOutput("🎉".repeat(MAX_UI_TOOL_OUTPUT_CHARS + 10));
    expect(Array.from(truncated)).toHaveLength(
      MAX_UI_TOOL_OUTPUT_CHARS + Array.from(UI_TOOL_OUTPUT_OMISSION).length,
    );
    expect(truncated.endsWith(UI_TOOL_OUTPUT_OMISSION)).toBe(true);
    // 壊れたサロゲート（半端なコードユニット）が残らない
    expect(truncated.replaceAll("🎉", "").replace(UI_TOOL_OUTPUT_OMISSION, "")).toBe("");
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

  it("bounds large tool output in the UI projection", () => {
    const long = "x".repeat(MAX_UI_TOOL_OUTPUT_CHARS + 1);
    const [message] = projectPiMessages([
      {
        role: "assistant",
        id: "a-large-output",
        timestamp: 1,
        content: [{ type: "toolCall", id: "call-large", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-large",
        content: [{ type: "text", text: long }],
        isError: false,
      },
    ]);
    const tool = message?.parts.find((part) => part.type === "tool");
    expect(tool?.type === "tool" && tool.state.output).toBe(
      `${"x".repeat(MAX_UI_TOOL_OUTPUT_CHARS)}\n…（以降省略）`,
    );
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

  it("does not classify an error without errorMessage as a silent turn", () => {
    const messages = projectPiMessages([
      { role: "user", id: "u1", timestamp: 1, content: "作業" },
      {
        role: "assistant",
        id: "a1",
        timestamp: 2,
        stopReason: "error",
        content: [],
      },
    ]);

    expect(messages[1]?.error).toBe("生成が失敗しました");
    expect(findResumableTurn(messages)).toBeNull();
  });

  it("projects provider diagnostics without stacks or arbitrary details", () => {
    const messages = projectPiMessages([
      {
        role: "assistant",
        id: "a-diagnostic",
        timestamp: 3,
        content: [],
        errorMessage: "fetch failed",
        diagnostics: [
          {
            type: "provider_transport_failure",
            timestamp: 4,
            error: {
              name: "TypeError",
              message: "fetch failed",
              code: "UND_ERR_CONNECT_TIMEOUT",
              stack: "Bearer secret-must-not-be-forwarded",
            },
            details: {
              configuredTransport: "auto",
              fallbackTransport: "sse",
              phase: "before_message_stream_start",
              eventsEmitted: false,
              requestBytes: 123,
              authorization: "secret-must-not-be-forwarded",
            },
          },
        ],
      },
    ]);

    expect(messages[0]).toMatchObject({
      error: "fetch failed",
      diagnostics: [
        {
          type: "provider_transport_failure",
          timestamp: 4,
          error: {
            name: "TypeError",
            message: "fetch failed",
            code: "UND_ERR_CONNECT_TIMEOUT",
          },
          details: {
            configuredTransport: "auto",
            fallbackTransport: "sse",
            phase: "before_message_stream_start",
            eventsEmitted: false,
            requestBytes: 123,
          },
        },
      ],
    });
    expect(JSON.stringify(messages[0]?.diagnostics)).not.toContain("secret-must-not-be-forwarded");
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
