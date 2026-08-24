import { describe, expect, it } from "vitest";
import {
  findResumableTurn,
  isAbortedAssistantMessage,
  MESSAGE_ABORTED_ERROR,
} from "./aborted-resume";
import type { UiMessage } from "./types";

function userMessage(id: string, text = "元のプロンプト"): UiMessage {
  return {
    id,
    role: "user",
    createdAt: 1,
    parts: [{ id: `${id}-t`, type: "text", text }],
  };
}

function abortedAssistant(id: string, error = "Aborted"): UiMessage {
  return {
    id,
    role: "assistant",
    createdAt: 2,
    error,
    parts: [{ id: `${id}-t`, type: "text", text: "途中まで" }],
  };
}

function reply(id: string, text = "完了"): UiMessage {
  return {
    id,
    role: "assistant",
    createdAt: 2,
    parts: [{ id: `${id}-t`, type: "text", text }],
  };
}

function emptyAssistant(id: string): UiMessage {
  return { id, role: "assistant", createdAt: 2, parts: [] };
}

describe("isAbortedAssistantMessage", () => {
  it("detects MessageAbortedError and abort-like strings", () => {
    expect(isAbortedAssistantMessage(abortedAssistant("a1"))).toBe(true);
    expect(
      isAbortedAssistantMessage(abortedAssistant("a2", MESSAGE_ABORTED_ERROR)),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isAbortedAssistantMessage(abortedAssistant("a3", "APIError: boom"))).toBe(false);
  });
});

describe("findResumableTurn", () => {
  it("returns silent resume for empty assistant turn", () => {
    expect(findResumableTurn([userMessage("u1"), emptyAssistant("a1")])).toEqual({
      reason: "silent",
      messageId: "a1",
      text: "元のプロンプト",
      files: [],
    });
  });

  it("returns silent resume for thinking-only assistant turn", () => {
    expect(
      findResumableTurn([
        userMessage("u1"),
        {
          id: "a1",
          role: "assistant",
          createdAt: 2,
          parts: [{ id: "a1-k", type: "thinking", text: "考えています" }],
        },
      ]),
    ).toMatchObject({ reason: "silent", messageId: "a1" });
  });

  it("returns aborted resume from manual abort id", () => {
    expect(
      findResumableTurn([userMessage("u1"), emptyAssistant("a1")], {
        manualAbortedAssistantId: "a1",
      }),
    ).toEqual({
      reason: "aborted",
      messageId: "a1",
      text: "元のプロンプト",
      files: [],
    });
  });

  it("ignores recovered turns after abort", () => {
    expect(
      findResumableTurn([userMessage("u1"), abortedAssistant("a1"), reply("a2")]),
    ).toBeNull();
  });

  it("restores image attachments", () => {
    const target = findResumableTurn([
      {
        id: "u1",
        role: "user",
        createdAt: 1,
        parts: [
          { id: "t1", type: "text", text: "見て" },
          {
            id: "i1",
            type: "image",
            url: "data:image/png;base64,abc",
            mime: "image/png",
            filename: "a.png",
          },
        ],
      },
      emptyAssistant("a1"),
    ]);
    expect(target?.files).toEqual([
      { uri: "data:image/png;base64,abc", mime: "image/png", name: "a.png" },
    ]);
  });
});
