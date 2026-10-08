// Compatibility entrypoint: Goal Loop timing/turn-budget rules live in backend core
// so the Backend process can validate starts and estimate cooldowns without the Web app.
export {
  DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS,
  DEFAULT_GOAL_LOOP_MAX_TURNS,
  formatGoalLoopCooldownSeconds,
  GOAL_LOOP_LIVE_STATUSES,
  isGoalLoopControlAction,
  shouldRollbackStaleGoalPrepare,
  MAX_GOAL_LOOP_ACCEPTANCE_ITEMS,
  MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS,
  MAX_GOAL_LOOP_COOLDOWN_SECONDS,
  MAX_GOAL_LOOP_TURNS,
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  isGoalLoopLiveStatus,
  isGoalLoopSessionOwnedStatus,
  nextGoalLoopTurn,
  normalizeGoalLoopAcceptance,
  normalizeGoalLoopMaxTurns,
  parseGoalLoopCooldownSeconds,
} from "@backend-core/goal-loop-settings.mjs";
