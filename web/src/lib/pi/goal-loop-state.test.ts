import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isGoalLoopLiveStatus, isGoalLoopOperatorHold, isGoalLoopSessionOwned, readGoalLoopState } from "./goal-loop-state";

const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readGoalLoopState", () => {
  it("reloads the state after the state file changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-"));
    tempDirs.push(cwd);
    process.env.LEAFCODE_PI_DATA_DIR = cwd;
    // 状態はプロジェクト配下ではなく dataDir()/goals-loop に置かれる。
    const stateDir = join(cwd, "goals-loop");
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

  it("fills progress and turnCount that the panel reads when the state file omits them", () => {
    const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-"));
    tempDirs.push(cwd);
    process.env.LEAFCODE_PI_DATA_DIR = cwd;
    const stateDir = join(cwd, "goals-loop");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "session.json"), JSON.stringify({ goal: "部分的な状態", status: "paused" }), "utf8");

    const loop = readGoalLoopState(cwd, "session");
    expect(loop?.progress).toEqual([]);
    expect(loop?.turnCount).toBe(0);
  });
});

describe("isGoalLoopLiveStatus", () => {
  it("treats queued, running, and verifying as live", () => {
    expect(isGoalLoopLiveStatus("queued")).toBe(true);
    expect(isGoalLoopLiveStatus("running")).toBe(true);
    expect(isGoalLoopLiveStatus("verifying_completed")).toBe(true);
    expect(isGoalLoopLiveStatus("paused")).toBe(false);
    expect(isGoalLoopLiveStatus("idle")).toBe(false);
  });
});

describe("isGoalLoopOperatorHold", () => {
  it("holds only user and manual_send pauses", () => {
    expect(isGoalLoopOperatorHold({ status: "paused", pauseReason: "user" })).toBe(true);
    expect(isGoalLoopOperatorHold({ status: "paused", pauseReason: "manual_send" })).toBe(true);
    expect(isGoalLoopOperatorHold({ status: "paused", pauseReason: "turn_limit" })).toBe(false);
    expect(isGoalLoopOperatorHold({ status: "running", pauseReason: "user" })).toBe(false);
    expect(isGoalLoopOperatorHold(null)).toBe(false);
  });
});

describe("isGoalLoopSessionOwned", () => {
  it("owns live, paused, and blocked loops until stop/complete", () => {
    expect(isGoalLoopSessionOwned({ status: "queued" })).toBe(true);
    expect(isGoalLoopSessionOwned({ status: "running" })).toBe(true);
    expect(isGoalLoopSessionOwned({ status: "verifying_completed" })).toBe(true);
    expect(isGoalLoopSessionOwned({ status: "paused" })).toBe(true);
    expect(isGoalLoopSessionOwned({ status: "blocked" })).toBe(true);
    expect(isGoalLoopSessionOwned({ status: "stopped" })).toBe(false);
    expect(isGoalLoopSessionOwned({ status: "completed" })).toBe(false);
    expect(isGoalLoopSessionOwned(null)).toBe(false);
  });
});
