import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGoalLoopState } from "./goal-loop-state";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readGoalLoopState", () => {
  it("reloads the state after the state file changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-"));
    tempDirs.push(cwd);
    const stateDir = join(cwd, ".pi", "goals-loop");
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, "session.json");
    const base = {
      goal: "最初の目標",
      status: "queued",
      maxTurns: 10,
      cooldownSeconds: 0,
      nextTurnAt: null,
      unreadableStreak: 0,
    };

    writeFileSync(file, JSON.stringify(base), "utf8");
    expect(readGoalLoopState(cwd, "session")?.goal).toBe("最初の目標");

    writeFileSync(file, JSON.stringify({ ...base, goal: "更新後の目標" }), "utf8");
    expect(readGoalLoopState(cwd, "session")?.goal).toBe("更新後の目標");
  });
});
