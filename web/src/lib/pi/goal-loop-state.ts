import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GoalLoopDto } from "@/lib/types";

export const GOAL_LOOP_DIR = ".pi/goals-loop";

export function goalLoopStateFile(cwd: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "session";
  return join(cwd, GOAL_LOOP_DIR, `${safeId}.json`);
}

export function readGoalLoopState(cwd: string, sessionId: string | null | undefined): GoalLoopDto | null {
  if (!sessionId) return null;
  try {
    const value = JSON.parse(readFileSync(goalLoopStateFile(cwd, sessionId), "utf8")) as Partial<GoalLoopDto>;
    if (!value || typeof value.goal !== "string" || typeof value.status !== "string") return null;
    return value as GoalLoopDto;
  } catch {
    return null;
  }
}
