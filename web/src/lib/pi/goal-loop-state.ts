import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GoalLoopDto } from "@/lib/types";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
} from "@/lib/goal-loop-settings";

export const GOAL_LOOP_DIR = ".pi/goals-loop";

type GoalLoopCacheEntry = {
  mtimeMs: number;
  size: number;
  ino: number;
  value: GoalLoopDto | null;
};

const goalLoopCache = new Map<string, GoalLoopCacheEntry>();

export const GOAL_LOOP_LIVE_STATUSES = [
  "queued",
  "running",
  "verifying_completed",
] as const;

export function isGoalLoopLiveStatus(
  status: string | null | undefined,
): boolean {
  return Boolean(status && (GOAL_LOOP_LIVE_STATUSES as readonly string[]).includes(status));
}

export function goalLoopStateFile(cwd: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "session";
  return join(cwd, GOAL_LOOP_DIR, `${safeId}.json`);
}

export function readGoalLoopState(cwd: string, sessionId: string | null | undefined): GoalLoopDto | null {
  if (!sessionId) return null;
  const file = goalLoopStateFile(cwd, sessionId);
  try {
    const stat = statSync(file);
    const cached = goalLoopCache.get(file);
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size &&
      cached.ino === stat.ino
    ) {
      return cached.value;
    }
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<GoalLoopDto>;
    if (!value || typeof value.goal !== "string" || typeof value.status !== "string") {
      goalLoopCache.delete(file);
      return null;
    }
    const result = {
      ...value,
      maxTurns: clampGoalLoopMaxTurns(value.maxTurns),
      cooldownSeconds: clampGoalLoopCooldownSeconds(value.cooldownSeconds),
      nextTurnAt: typeof value.nextTurnAt === "string" ? value.nextTurnAt : null,
      unreadableStreak: Math.max(0, Math.trunc(Number(value.unreadableStreak) || 0)),
    } as GoalLoopDto;
    goalLoopCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, value: result });
    return result;
  } catch {
    goalLoopCache.delete(file);
    return null;
  }
}
