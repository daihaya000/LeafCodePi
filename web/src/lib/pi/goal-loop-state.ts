import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GoalLoopDto } from "@/lib/types";
import { dataDir } from "@/lib/paths";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
} from "@/lib/goal-loop-settings";

/**
 * 状態はプロジェクト配下に置かない（LeafCodePiはプロジェクト内 .pi を許可しない）。
 * Pi拡張側（extensions/leafcode-goal-loop/index.ts の goalsDir()）と同じ基底：
 * dataDir()/goals-loop/<sessionId>.json。LEAFCODE_PI_DATA_DIRで両側を一括上書きする。
 */
const GOAL_LOOP_DIR = "goals-loop";

type GoalLoopCacheEntry = {
  mtimeMs: number;
  size: number;
  ino: number;
  value: GoalLoopDto | null;
};

const goalLoopCache = new Map<string, GoalLoopCacheEntry>();
/** キャッシュ上限。全タスク走査で 400+ 件の状態ファイルを stat するため、
 *  上限以下で毎回追い出されて再読込が起きないよう余裕を持たせる。 */
const GOAL_LOOP_CACHE_MAX_ENTRIES = 2048;

function cacheGoalLoopState(file: string, entry: GoalLoopCacheEntry): void {
  if (
    goalLoopCache.size >= GOAL_LOOP_CACHE_MAX_ENTRIES &&
    !goalLoopCache.has(file)
  ) {
    const oldest = goalLoopCache.keys().next().value;
    if (oldest !== undefined) goalLoopCache.delete(oldest);
  }
  goalLoopCache.set(file, entry);
}

export const GOAL_LOOP_LIVE_STATUSES = [
  "queued",
  "running",
  "verifying_completed",
] as const;

/** Operator-held pauses that expect Resume — must not settle Bot Code outbox yet. */
const GOAL_LOOP_OPERATOR_HOLD_REASONS = new Set(["user", "manual_send"]);

export function isGoalLoopLiveStatus(
  status: string | null | undefined,
): boolean {
  return Boolean(status && (GOAL_LOOP_LIVE_STATUSES as readonly string[]).includes(status));
}

/** True when the loop is paused for a user/operator hold (not turn_limit / blocked). */
export function isGoalLoopOperatorHold(
  loop: { status?: string | null; pauseReason?: string | null } | null | undefined,
): boolean {
  return loop?.status === "paused" && GOAL_LOOP_OPERATOR_HOLD_REASONS.has(loop.pauseReason ?? "");
}

/**
 * Goal Loop still owns the session (Resume/Stop available). Includes pause/block —
 * not only live turn statuses — so ensureLive keeps Goal Loop transport/compaction.
 */
export function isGoalLoopSessionOwned(
  loop: { status?: string | null } | null | undefined,
): boolean {
  const status = loop?.status;
  if (!status) return false;
  if (isGoalLoopLiveStatus(status)) return true;
  return status === "paused" || status === "blocked";
}

/** cwd引数は呼び出し元互換のため残す。状態配置はグローバルでcwd非依存。 */
export function goalLoopStateFile(_cwd: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "session";
  return join(dataDir(), GOAL_LOOP_DIR, `${safeId}.json`);
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
    cacheGoalLoopState(file, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
      value: result,
    });
    return result;
  } catch {
    goalLoopCache.delete(file);
    return null;
  }
}
