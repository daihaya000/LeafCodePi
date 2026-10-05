import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/client";
import {
  hasNewRoomUserMessageSince,
  hasNewUserMessageSince,
  hasReceivedSubmittedPrompt,
  isUnconfirmedPromptDelivery,
  optimisticUserMessage,
  shouldShowWorkingRow,
} from "./prompt-delivery";
import type { UiMessage } from "@/lib/types";

const message = (id: string, text: string, createdAt: number): UiMessage => ({
  id,
  role: "user",
  createdAt,
  parts: [{ type: "text", text }],
});

describe("prompt-delivery", () => {
  it("reconciles only transport forward failures", () => {
    expect(isUnconfirmedPromptDelivery(new ApiError("x", 502, { code: "BACKEND_FORWARD_FAILED", reason: "unreachable" }))).toBe(true);
    expect(isUnconfirmedPromptDelivery(new ApiError("x", 502, { code: "BACKEND_FORWARD_FAILED", reason: "bad-response" }))).toBe(true);
    expect(isUnconfirmedPromptDelivery(new ApiError("x", 409, { code: "BACKEND_FORWARD_FAILED", reason: "not-configured" }))).toBe(false);
    expect(isUnconfirmedPromptDelivery(new ApiError("x", 401, { code: "BACKEND_FORWARD_FAILED", reason: "unauthorized" }))).toBe(false);
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

  it("builds a text-only optimistic user row", () => {
    const echo = optimisticUserMessage("hello", 42);
    expect(echo.role).toBe("user");
    expect(echo.createdAt).toBe(42);
    expect(echo.parts).toEqual([{ id: `${echo.id}:text`, type: "text", text: "hello" }]);
  });
});
