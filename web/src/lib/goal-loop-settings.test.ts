import { describe, expect, it } from "vitest";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  formatGoalLoopCooldownSeconds,
  MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS,
  MAX_GOAL_LOOP_ACCEPTANCE_ITEMS,
  normalizeGoalLoopAcceptance,
  parseGoalLoopCooldownSeconds,
} from "./goal-loop-settings";

describe("goal loop settings", () => {
  it("uses zero as the unlimited max-turn sentinel", () => {
    expect(clampGoalLoopMaxTurns(0)).toBe(0);
    expect(clampGoalLoopMaxTurns(101)).toBe(100);
    expect(clampGoalLoopMaxTurns("", 10)).toBe(10);
  });

  it("parses and clamps human-readable cooldowns", () => {
    expect(parseGoalLoopCooldownSeconds("15m 30s")).toBe(930);
    expect(clampGoalLoopCooldownSeconds("2h")).toBe(7_200);
    expect(clampGoalLoopCooldownSeconds("invalid")).toBe(0);
    expect(formatGoalLoopCooldownSeconds(9_330)).toBe("2h 35m 30s");
  });

  it("normalizes an absent acceptance list to empty, not null", () => {
    expect(normalizeGoalLoopAcceptance(undefined)).toEqual([]);
    expect(normalizeGoalLoopAcceptance(null)).toEqual([]);
  });

  it("trims items and drops blank entries", () => {
    expect(normalizeGoalLoopAcceptance(["  テストが通る  ", "", "   "])).toEqual(["テストが通る"]);
  });

  it("rejects a non-array, an oversized list, or an oversized item", () => {
    expect(normalizeGoalLoopAcceptance("not an array")).toBeNull();
    expect(normalizeGoalLoopAcceptance([1, 2])).toBeNull();
    expect(
      normalizeGoalLoopAcceptance(Array.from({ length: MAX_GOAL_LOOP_ACCEPTANCE_ITEMS + 1 }, (_, i) => `item ${i}`)),
    ).toBeNull();
    expect(normalizeGoalLoopAcceptance(["x".repeat(MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS + 1)])).toBeNull();
    expect(normalizeGoalLoopAcceptance(["x".repeat(MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS)])).toEqual([
      "x".repeat(MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS),
    ]);
  });
});
