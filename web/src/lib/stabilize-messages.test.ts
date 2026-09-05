import { describe, expect, it } from "vitest";
import {
  messageRenderKey,
  stabilizeUiMessages,
  upsertUiMessage,
} from "./stabilize-messages";
import type { UiMessage } from "./types";

function textMessage(id: string, text: string, extra?: Partial<UiMessage>): UiMessage {
  return {
    id,
    role: "assistant",
    createdAt: 1,
    parts: [{ type: "text", id: `${id}-t`, text }],
    ...extra,
  };
}

function toolMessage(id: string, output: string): UiMessage {
  return {
    id,
    role: "assistant",
    createdAt: 1,
    parts: [
      {
        id: `${id}-tool`,
        type: "tool",
        tool: "bash",
        callID: `${id}-call`,
        state: { status: "running", output },
      },
    ],
  };
}

function toolInputMessage(id: string, input: string, subagentRunIds?: string[]): UiMessage {
  return {
    id,
    role: "assistant",
    createdAt: 1,
    parts: [
      {
        id: `${id}-tool`,
        type: "tool",
        tool: "bash",
        callID: `${id}-call`,
        state: {
          status: "running",
          input: { command: input },
          ...(subagentRunIds ? { subagentRunIds } : {}),
        },
      },
    ],
  };
}

describe("messageRenderKey", () => {
  it("keeps a streamed row mounted after its persisted id is assigned", () => {
    const streamed = textMessage("msg-3", "実行します");
    const persisted = { ...streamed, id: "entry-42" };

    expect(messageRenderKey(persisted)).toBe(messageRenderKey(streamed));
  });
});

describe("stabilizeUiMessages", () => {
  it.each(["text", "thinking", "image", "input", "output", "error", "subagentRunIds"] as const)(
    "compares the full %s value in snapshots and deltas",
    (field) => {
      const message = (prefix: string): UiMessage => {
        const value = prefix + "same suffix".repeat(10);
        const part = field === "text" || field === "thinking"
          ? { type: field, id: "part", text: value }
          : field === "image"
            ? { type: "image" as const, id: "part", url: value, mime: "image/png" }
            : { type: "tool" as const, id: "part", callID: "call", tool: "bash", state: {
                status: "running" as const,
                [field]: field === "input" ? { command: value } : field === "subagentRunIds" ? [value] : value,
              } };
        return { id: "a", role: "assistant", createdAt: 1, parts: [part] };
      };
      const previous = [message("a")];
      const next = message("b");
      expect(stabilizeUiMessages(previous, [next])[0]).toBe(next);
      expect(upsertUiMessage(previous, next)[0]).toBe(next);
      expect(upsertUiMessage(previous, structuredClone(previous[0]!))).toBe(previous);
    },
  );

  it("reuses references when content is unchanged", () => {
    const prev = [textMessage("a", "hello"), textMessage("b", "world")];
    const next = [textMessage("a", "hello"), textMessage("b", "world")];
    const out = stabilizeUiMessages(prev, next);
    expect(out).toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
  });

  it("updates only changed messages", () => {
    const prev = [textMessage("a", "hello"), textMessage("b", "world")];
    const next = [textMessage("a", "hello"), textMessage("b", "world!")];
    const out = stabilizeUiMessages(prev, next);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).not.toBe(prev[1]);
    expect(out[1]?.parts[0]).toMatchObject({ text: "world!" });
  });

  it("updates a streamed tool when the output changes at the same length", () => {
    const prev = [toolMessage("a", "first output")];
    const next = [toolMessage("a", "second text")];
    const out = stabilizeUiMessages(prev, next);
    expect(out[0]).not.toBe(prev[0]);
    expect(out[0]?.parts[0]).toMatchObject({ state: { output: "second text" } });
  });

  it("updates when account or model metadata is applied later", () => {
    const prev = [textMessage("a", "hello")];
    const next = [{ ...textMessage("a", "hello"), accountId: "acc-1", model: "gpt", provider: "openai" }];
    const out = stabilizeUiMessages(prev, next);
    expect(out[0]).not.toBe(prev[0]);
    expect(out[0]).toMatchObject({ accountId: "acc-1", model: "gpt", provider: "openai" });
  });

  it("updates a streamed tool when its input changes", () => {
    const prev = [toolInputMessage("a", "first command")];
    const next = [toolInputMessage("a", "second command")];
    const out = stabilizeUiMessages(prev, next);
    expect(out[0]).not.toBe(prev[0]);
    expect(out[0]?.parts[0]).toMatchObject({
      state: { input: { command: "second command" } },
    });
  });

  it("updates a streamed tool when its subagent run ids change", () => {
    const prev = [toolInputMessage("a", "command", ["run-a"])];
    const next = [toolInputMessage("a", "command", ["run-b"])];
    const out = stabilizeUiMessages(prev, next);
    expect(out[0]).not.toBe(prev[0]);
    expect(out[0]?.parts[0]).toMatchObject({
      state: { subagentRunIds: ["run-b"] },
    });
  });

  it("updates when provider diagnostics change", () => {
    const prev = [textMessage("a", "", { diagnostics: [{ type: "transport" }] })];
    const next = [textMessage("a", "", { diagnostics: [{ type: "transport", details: { phase: "sse" } }] })];

    const out = stabilizeUiMessages(prev, next);
    expect(out[0]).not.toBe(prev[0]);
    expect(out[0]?.diagnostics?.[0]?.details?.phase).toBe("sse");
  });
});

describe("upsertUiMessage", () => {
  it("updates only the delta message without fingerprinting the full history", () => {
    const first = textMessage("a", "hello");
    const second = textMessage("b", "world");
    const previous = [first, second];
    const next = upsertUiMessage(previous, textMessage("b", "world!"));

    expect(next).not.toBe(previous);
    expect(next[0]).toBe(first);
    expect(next[1]).not.toBe(second);
    expect(next[1]?.parts[0]).toMatchObject({ text: "world!" });
  });

  it("updates a streamed tool delta when its input changes", () => {
    const previous = [toolInputMessage("a", "first command")];
    const next = upsertUiMessage(previous, toolInputMessage("a", "second command"));

    expect(next).not.toBe(previous);
    expect(next[0]?.parts[0]).toMatchObject({
      state: { input: { command: "second command" } },
    });
  });

  it("appends a new streamed message", () => {
    const first = textMessage("a", "hello");
    const next = upsertUiMessage([first], textMessage("b", "world"));
    expect(next).toEqual([first, textMessage("b", "world")]);
  });

  it("replaces a streamed row when its persisted id changes", () => {
    const streamed = textMessage("msg-3", "hello");
    const persisted = { ...streamed, id: "entry-42" };

    expect(upsertUiMessage([streamed], persisted)).toEqual([persisted]);
  });
});
