import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/client";
import { hasReceivedSubmittedPrompt, isUnconfirmedPromptDelivery } from "./prompt-delivery";
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
});
