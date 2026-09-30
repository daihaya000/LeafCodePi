import { GoalLoopStateStore } from "@backend-core/goal-loop-state.mjs";
import type { GoalLoopDto } from "@/lib/types";
import { dataDir } from "@/lib/paths";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  isGoalLoopSessionOwnedStatus,
} from "@/lib/goal-loop-settings";

export { GOAL_LOOP_LIVE_STATUSES, isGoalLoopLiveStatus } from "@/lib/goal-loop-settings";

// Compatibility entrypoint. Files live in backend core; the data directory and the
// settings clamps are injected, and the process-local cache belongs to the store.
const store = new GoalLoopStateStore({
  dataDir,
  clampMaxTurns: clampGoalLoopMaxTurns,
  clampCooldownSeconds: clampGoalLoopCooldownSeconds,
});

/** True when the loop is paused for a user/operator hold (not turn_limit / blocked). */
export function isGoalLoopOperatorHold(
  loop: { status?: string | null; pauseReason?: string | null } | null | undefined,
): boolean {
  return GoalLoopStateStore.isOperatorHold(loop);
}

/**
 * Goal Loop still owns the session (Resume/Stop available). Includes pause/block —
 * not only live turn statuses — so ensureLive keeps Goal Loop transport/compaction.
 */
export function isGoalLoopSessionOwned(
  loop: { status?: string | null } | null | undefined,
): boolean {
  return isGoalLoopSessionOwnedStatus(loop?.status);
}

/** cwd引数は呼び出し元互換のため残す。状態配置はグローバルでcwd非依存。 */
export function goalLoopStateFile(cwd: string, sessionId: string): string {
  return store.stateFile(cwd, sessionId);
}

export function readGoalLoopState(cwd: string, sessionId: string | null | undefined): GoalLoopDto | null {
  return store.read(cwd, sessionId);
}
