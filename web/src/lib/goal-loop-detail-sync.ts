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
  const terminal = summary.status === "stopped" || summary.status === "completed";
  const hold = summary.status === "paused" || summary.status === "blocked";
  if (
    detail.status === summary.status &&
    detail.maxTurns === summary.maxTurns &&
    detail.turnCount === summary.turnCount &&
    // A matching status can still carry a stale countdown / pauseReason after interrupt.
    !(terminal && (detail.nextTurnAt || detail.pauseReason || detail.error || detail.pendingTurnRecovery)) &&
    !(hold && detail.nextTurnAt)
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
      : summary.status === "paused" || summary.status === "blocked"
        // Interrupt/pause during cooldown must drop the countdown immediately.
        ? { nextTurnAt: null, pendingTurnRecovery: false }
        : {}),
  };
}

export type GoalLoopControlAction = "pause" | "resume" | "stop" | "complete";

/**
 * A control can race the loop's own transition (Pause pressed as the loop completes, Stop while
 * a composer Stop already ended it, Resume from a second tab). When the refreshed state already
 * delivers what the user asked for, the failed request is not an error worth a red banner.
 */
export function goalLoopActionSatisfied(
  action: GoalLoopControlAction,
  loop: GoalLoopDto | null | undefined,
): boolean {
  const status = loop?.status;
  const terminal = !loop || status === "stopped" || status === "completed";
  switch (action) {
    case "stop":
      return terminal;
    case "pause":
      return status === "paused" || status === "blocked";
    case "complete":
      return status === "completed";
    case "resume":
      return status === "queued" || status === "running" || status === "verifying_completed";
  }
}

/** Friendlier text for a control that lost the race to the loop ending on its own. */
export function goalLoopActionConflictMessage(
  action: GoalLoopControlAction,
  loop: GoalLoopDto | null | undefined,
): string | null {
  if (goalLoopActionSatisfied(action, loop)) return null;
  if (!loop || loop.status === "stopped") return "Goal Loop は既に停止しています";
  if (loop.status === "completed") return "Goal Loop は既に完了しています";
  return null;
}
