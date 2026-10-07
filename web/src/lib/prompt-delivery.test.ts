import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/client";
import {
  hasNewRoomUserMessageSince,
  hasNewUserMessageSince,
  hasReceivedSubmittedPrompt,
  isUnconfirmedPromptDelivery,
  optimisticUserMessage,
  isStreamingTextTail,
  optimisticAttachmentPreviews,
  shouldShowWorkingRow,
} from "./prompt-delivery";
import type { UiMessage } from "@/lib/types";

const message = (id: string, text: string, createdAt: number): UiMessage => ({
  id,
  role: "user",
  createdAt,
  parts: [{ id: `${id}-text`, type: "text", text }],
});

describe("prompt-delivery", () => {
  it("reconciles only transport forward failures", () => {
    expect(isUnconfirmedPromptDelivery(new ApiError("x", 502, { code: "BACKEND_FORWARD_FAILED", reason: "unreachable" }))).toBe(true);
    expect(isUnconfirmedPromptDelivery(new ApiError("x", 502, { code: "BACKEND_FORWARD_FAILED", reason: "bad-response" }))).toBe(true);
    expect(isUnconfirmedPromptDelivery(new ApiError("x", 409, { code: "BACKEND_FORWARD_FAILED", reason: "not-configured" }))).toBe(false);
    expect(isUnconfirmedPromptDelivery(new ApiError("x", 401, { code: "BACKEND_FORWARD_FAILED", reason: "unauthorized" }))).toBe(false);
    expect(isUnconfirmedPromptDelivery(new ApiError("x", 408, { reason: "timeout" }))).toBe(true);
    expect(isUnconfirmedPromptDelivery(new ApiError("x", 408))).toBe(false);
    expect(isUnconfirmedPromptDelivery(new ApiError("plain", 500))).toBe(false);
  });

  it("requires a newer user message with the submitted text", () => {
    const before = [message("u1", "old", 1)];
    expect(hasReceivedSubmittedPrompt(before, before, "hello")).toBe(false);
    expect(hasReceivedSubmittedPrompt(before, [...before, message("u1", "hello", 2)], "hello")).toBe(false);
    expect(hasReceivedSubmittedPrompt(before, [...before, message("u2", "hello", 2)], "hello")).toBe(true);
    expect(hasReceivedSubmittedPrompt(before, [...before, message("u2", "hello", 0)], "hello")).toBe(false);
  });

  it("clears the optimistic echo on any newer user row, even with rewritten text", () => {
    const before = [message("u1", "old", 10)];
    expect(hasNewUserMessageSince(before, before)).toBe(false);
    expect(hasNewUserMessageSince(before, [...before, message("u2", "rewritten by a skill", 11)])).toBe(true);
    // A remapped id of an older row is not the new prompt.
    expect(hasNewUserMessageSince(before, [message("entry-1", "old", 10)])).toBe(false);
    expect(hasNewUserMessageSince(before, [...before, { ...message("u3", "retry", 12), hangRetry: true }])).toBe(false);
  });


  it("detects a new Room user id that was absent before the send", () => {
    const before = new Set(["u1"]);
    expect(hasNewRoomUserMessageSince(before, [{ id: "u1", role: "user" }])).toBe(false);
    expect(hasNewRoomUserMessageSince(before, [{ id: "u1", role: "user" }, { id: "a1", role: "assistant" }])).toBe(false);
    expect(hasNewRoomUserMessageSince(before, [{ id: "u1", role: "user" }, { id: "u2", role: "user" }])).toBe(true);
  });

  it("hides WorkingRow once assistant text is streaming without a running tool", () => {
    expect(shouldShowWorkingRow(false, [])).toBe(false);
    expect(shouldShowWorkingRow(true, [])).toBe(true);
    const thinking: UiMessage = {
      id: "a1",
      role: "assistant",
      createdAt: 1,
      parts: [{ id: "t", type: "thinking", text: "..." }],
    };
    expect(shouldShowWorkingRow(true, [thinking])).toBe(true);
    const streaming: UiMessage = {
      id: "a2",
      role: "assistant",
      createdAt: 2,
      parts: [{ id: "x", type: "text", text: "Hello" }],
    };
    expect(shouldShowWorkingRow(true, [streaming])).toBe(false);
    const tool = {
      id: "a3",
      role: "assistant" as const,
      createdAt: 3,
      parts: [
        { id: "x", type: "text" as const, text: "Hi" },
        { id: "tool", type: "tool" as const, tool: "bash", callID: "c1", state: { status: "running" as const, input: {} } },
      ],
    } as UiMessage;
    expect(shouldShowWorkingRow(true, [tool])).toBe(true);
  });

  it("keeps WorkingRow for a new turn even when the previous turn ended in text", () => {
    const answered: UiMessage = { id: "a1", role: "assistant", createdAt: 1, parts: [{ id: "x", type: "text", text: "done" }] };
    const followUp: UiMessage = { id: "u2", role: "user", createdAt: 2, parts: [{ id: "y", type: "text", text: "next" }] };
    // The sent follow-up has landed but nothing streams yet: the old answer must not hide the row.
    expect(shouldShowWorkingRow(true, [answered, followUp])).toBe(true);
    // The echo is outside `messages`: the previous answer is still last, the row still shows.
    expect(shouldShowWorkingRow(true, [answered], true)).toBe(true);
    // Text followed by a finished tool means the next step is pending: show the row.
    const afterTool = {
      id: "a3",
      role: "assistant" as const,
      createdAt: 3,
      parts: [
        { id: "x", type: "text" as const, text: "Let me check" },
        { id: "tool", type: "tool" as const, tool: "bash", callID: "c1", state: { status: "completed" as const, input: {}, output: "" } },
      ],
    } as UiMessage;
    expect(shouldShowWorkingRow(true, [afterTool])).toBe(true);
    expect(isStreamingTextTail(afterTool)).toBe(false);
    expect(isStreamingTextTail(answered)).toBe(true);
  });

  it("echoes attachments as image and file parts", () => {
    const echo = optimisticUserMessage("see", 7, [
      { uri: "data:image/png;base64,AAAA", mime: "image/png", name: "a.png" },
      { uri: "data:text/plain;base64,BBBB", mime: "text/plain", name: "notes.txt" },
    ]);
    expect(echo.parts.map((part) => part.type)).toEqual(["text", "image", "file"]);
    expect(optimisticUserMessage("", 8, [{ uri: "data:image/png;base64,AAAA", mime: "image/png" }]).parts.map((part) => part.type)).toEqual(["image"]);
    const previews = optimisticAttachmentPreviews(7, [
      { uri: "data:image/png;base64,AAAA", mime: "image/png", name: "a.png" },
      { uri: "data:text/plain;base64,BBBB", mime: "text/plain", name: "notes.txt" },
    ]);
    expect(previews.images).toHaveLength(1);
    expect(previews.files).toEqual([expect.objectContaining({ name: "notes.txt" })]);
  });

  it("builds a text-only optimistic user row", () => {
    const echo = optimisticUserMessage("hello", 42);
    expect(echo.role).toBe("user");
    expect(echo.createdAt).toBe(42);
    expect(echo.parts).toEqual([{ id: `${echo.id}:text`, type: "text", text: "hello" }]);
  });
});
