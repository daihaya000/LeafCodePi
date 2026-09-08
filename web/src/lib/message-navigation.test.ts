import { describe, expect, it } from "vitest";
import { messageNavigationIds, messageNavigationTarget } from "./message-navigation";

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

describe("messageNavigationTarget", () => {
  const tops = [0, 200, 400];
  const topOf = (index: number) => tops[index]!;

  it("previous picks the last target above the line", () => {
    expect(messageNavigationTarget(tops.length, 250, topOf, -1)).toBe(1);
    // 最下部まで読んだ状態でも二つ前へ飛ばない。
    expect(messageNavigationTarget(tops.length, 900, topOf, -1)).toBe(2);
  });

  it("previous stays on the first target when already at the top", () => {
    expect(messageNavigationTarget(tops.length, 0, topOf, -1)).toBe(0);
  });

  it("next picks the first target below the line and ignores the aligned one", () => {
    expect(messageNavigationTarget(tops.length, 200, topOf, 1)).toBe(2);
    expect(messageNavigationTarget(tops.length, 100, topOf, 1)).toBe(1);
  });

  it("returns null when no target remains", () => {
    expect(messageNavigationTarget(tops.length, 900, topOf, 1)).toBeNull();
    expect(messageNavigationTarget(0, 100, () => 0, -1)).toBeNull();
  });
});
