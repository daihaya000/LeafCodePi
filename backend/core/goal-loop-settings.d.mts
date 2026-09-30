export const DEFAULT_GOAL_LOOP_MAX_TURNS: number;
export const MAX_GOAL_LOOP_TURNS: number;
export const DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS: number;
export const MAX_GOAL_LOOP_COOLDOWN_SECONDS: number;
export const MAX_GOAL_LOOP_ACCEPTANCE_ITEMS: number;
export const MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS: number;

export const GOAL_LOOP_LIVE_STATUSES: readonly string[];

export function isGoalLoopLiveStatus(status: string | null | undefined): boolean;
export function isGoalLoopSessionOwnedStatus(status: string | null | undefined): boolean;
export function nextGoalLoopTurn(loop: {
  status?: string | null;
  turnCount?: number | null;
  retryInterruptedTurn?: boolean | null;
}): number;
export function normalizeGoalLoopMaxTurns(value: unknown): number | null;
export function clampGoalLoopMaxTurns(value: unknown, fallback?: number): number;
export function normalizeGoalLoopAcceptance(value: unknown): string[] | null;
export function parseGoalLoopCooldownSeconds(value: unknown): number;
export function clampGoalLoopCooldownSeconds(value: unknown): number;
export function formatGoalLoopCooldownSeconds(value: number): string;
