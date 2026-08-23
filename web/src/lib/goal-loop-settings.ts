/** Goal Loop timing and turn-budget settings shared by UI and API routes. */
export const DEFAULT_GOAL_LOOP_MAX_TURNS = 10;
export const MAX_GOAL_LOOP_TURNS = 100;
export const DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS = 0;
export const MAX_GOAL_LOOP_COOLDOWN_SECONDS = 24 * 60 * 60;

/** Zero is the explicit no-limit sentinel. */
export function normalizeGoalLoopMaxTurns(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(MAX_GOAL_LOOP_TURNS, Math.max(0, Math.trunc(number)));
}

export function clampGoalLoopMaxTurns(
  value: unknown,
  fallback = DEFAULT_GOAL_LOOP_MAX_TURNS,
): number {
  return normalizeGoalLoopMaxTurns(value) ?? fallback;
}

const DURATION_TOKEN = /(\d+(?:\.\d+)?)\s*([smhd])/gi;

export function parseGoalLoopCooldownSeconds(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS;
  const text = value.trim();
  if (!text) return DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return Number(text);

  DURATION_TOKEN.lastIndex = 0;
  let cursor = 0;
  let total = 0;
  let matched = false;
  let token: RegExpExecArray | null;
  while ((token = DURATION_TOKEN.exec(text))) {
    if (text.slice(cursor, token.index).trim()) return DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS;
    const multiplier = token[2].toLowerCase() === "d"
      ? 24 * 60 * 60
      : token[2].toLowerCase() === "h"
        ? 60 * 60
        : token[2].toLowerCase() === "m"
          ? 60
          : 1;
    total += Number(token[1]) * multiplier;
    cursor = DURATION_TOKEN.lastIndex;
    matched = true;
  }
  return matched && !text.slice(cursor).trim()
    ? total
    : DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS;
}

export function clampGoalLoopCooldownSeconds(value: unknown): number {
  const number = parseGoalLoopCooldownSeconds(value);
  if (!Number.isFinite(number)) return DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS;
  return Math.min(MAX_GOAL_LOOP_COOLDOWN_SECONDS, Math.max(0, Math.trunc(number)));
}

export function formatGoalLoopCooldownSeconds(value: number): string {
  const seconds = clampGoalLoopCooldownSeconds(value);
  if (seconds === 0) return "0";
  const parts: string[] = [];
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remaining = seconds % 60;
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (remaining) parts.push(`${remaining}s`);
  return parts.join(" ");
}
