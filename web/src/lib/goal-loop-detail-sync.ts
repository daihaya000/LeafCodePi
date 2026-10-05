import type { GoalLoopDto, GoalLoopSummaryDto } from "./types";

/**
 * Abort / list APIs return TaskSummary.goalLoopSummary only. TaskView keeps the
 * full TaskDetail.goalLoop for the panel - merge summary fields so Stop cannot
 * leave the panel stuck on running until the next SSE snapshot.
 */
export function applyGoalLoopSummaryToDetail(
  detail: GoalLoopDto | null | undefined,
  summary: GoalLoopSummaryDto | null | undefined,
): GoalLoopDto | null | undefined {
  if (!detail) return detail;
  if (!summary) return detail;
  if (
    detail.status === summary.status &&
    detail.maxTurns === summary.maxTurns &&
    detail.turnCount === summary.turnCount
  ) {
    return detail;
  }
  return {
    ...detail,
    status: summary.status,
    maxTurns: summary.maxTurns,
    turnCount: summary.turnCount,
    ...(summary.status === "stopped" || summary.status === "completed"
      ? { pauseReason: "" as const, error: "", nextTurnAt: null, pendingTurnRecovery: false }
      : {}),
  };
}
