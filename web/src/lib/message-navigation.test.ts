import { describe, expect, it } from "vitest";
import { messageNavigationIds, messageNavigationIndex } from "./message-navigation";

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

describe("messageNavigationIndex", () => {
  const tops = [0, 200, 400];
  const topOf = (index: number) => tops[index]!;

  it("keeps the current target until the next target reaches the viewport line", () => {
    expect(messageNavigationIndex(tops.length, 0, 100, topOf)).toBe(0);
    expect(messageNavigationIndex(tops.length, 0, 200, topOf)).toBe(1);
  });

  it("moves backward to the target at or above the line", () => {
    expect(messageNavigationIndex(tops.length, 2, 250, topOf)).toBe(1);
    expect(messageNavigationIndex(tops.length, 2, 0, topOf)).toBe(0);
  });

  it("returns zero when there are no targets", () => {
    expect(messageNavigationIndex(0, 3, 100, () => 0)).toBe(0);
  });
});
