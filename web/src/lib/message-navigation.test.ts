import { describe, expect, it } from "vitest";
import { messageNavigationIds } from "./message-navigation";

describe("messageNavigationIds", () => {
  it("uses user messages when the conversation has them", () => {
    expect(messageNavigationIds([
      { id: "assistant-1", role: "assistant" },
      { id: "user-1", role: "user" },
      { id: "assistant-2", role: "assistant" },
      { id: "user-2", role: "user" },
    ])).toEqual(["user-1", "user-2"]);
  });

  it("falls back to visible non-summary messages for Goal Loop runs", () => {
    expect(messageNavigationIds([
      { id: "summary", role: "compaction" },
      { id: "assistant-1", role: "assistant" },
    ])).toEqual(["assistant-1"]);
  });
});
