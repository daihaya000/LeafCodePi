import { describe, expect, it } from "vitest";
import {
  countHangRetryUserMessages,
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
});
