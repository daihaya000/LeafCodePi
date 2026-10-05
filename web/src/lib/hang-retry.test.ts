import { describe, expect, it } from "vitest";
import {
  countHangRetryUserMessages,
  hangRetryNoticeCount,
  HANG_RETRY_PREFIX,
  isHangRetryUserMessage,
  markHangRetryPrompt,
  stripHangRetryPrefix,
} from "./hang-retry";
import type { UiMessage } from "./types";

function userMessage(id: string, text: string): UiMessage {
  return {
    id,
    role: "user",
    createdAt: 1,
    parts: [{ id: `${id}-t`, type: "text", text }],
  };
}

describe("hang-retry", () => {
  it("marks and detects hang retry prompts", () => {
    const marked = markHangRetryPrompt("hello");
    expect(marked.startsWith(HANG_RETRY_PREFIX)).toBe(true);
    expect(stripHangRetryPrefix(marked)).toBe("hello");
  });

  it("counts hang retry user messages", () => {
    const messages: UiMessage[] = [
      {
        id: "u1",
        role: "user",
        createdAt: 1,
        hangRetry: true,
        parts: [{ id: "t1", type: "text", text: "hello" }],
      },
      userMessage("u2", "normal"),
    ];
    expect(isHangRetryUserMessage(messages[0]!)).toBe(true);
    expect(countHangRetryUserMessages(messages)).toBe(1);
  });

  it("does not keep the hang notice from historical retries after a real user turn", () => {
    const messages: UiMessage[] = [
      {
        id: "u1",
        role: "user",
        createdAt: 1,
        hangRetry: true,
        parts: [{ id: "t1", type: "text", text: "hello" }],
      },
      {
        id: "u2",
        role: "user",
        createdAt: 2,
        hangRetry: true,
        parts: [{ id: "t2", type: "text", text: "again" }],
      },
      userMessage("u3", "fresh turn"),
    ];
    expect(countHangRetryUserMessages(messages)).toBe(2);
    expect(hangRetryNoticeCount(0, messages)).toBe(0);
    expect(hangRetryNoticeCount(2, messages)).toBe(2);
  });

  it("falls back to one while the tip user message is still a hang retry", () => {
    const messages: UiMessage[] = [
      userMessage("u1", "original"),
      {
        id: "u2",
        role: "user",
        createdAt: 2,
        hangRetry: true,
        parts: [{ id: "t2", type: "text", text: "retry" }],
      },
    ];
    expect(hangRetryNoticeCount(0, messages)).toBe(1);
  });
});
