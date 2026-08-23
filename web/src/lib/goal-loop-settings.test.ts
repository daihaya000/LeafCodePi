import { describe, expect, it } from "vitest";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  formatGoalLoopCooldownSeconds,
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
});
