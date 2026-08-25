import { describe, expect, it } from "vitest";
import { stabilizeUiMessages, upsertUiMessage } from "./stabilize-messages";
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

describe("stabilizeUiMessages", () => {
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

  it("appends a new streamed message", () => {
    const first = textMessage("a", "hello");
    const next = upsertUiMessage([first], textMessage("b", "world"));
    expect(next).toEqual([first, textMessage("b", "world")]);
  });
});
