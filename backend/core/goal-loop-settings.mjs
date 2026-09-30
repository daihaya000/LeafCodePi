/** Goal Loop timing and turn-budget settings shared by UI and API routes. */
export const DEFAULT_GOAL_LOOP_MAX_TURNS = 10;
export const MAX_GOAL_LOOP_TURNS = 100;
export const DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS = 0;
export const MAX_GOAL_LOOP_COOLDOWN_SECONDS = 24 * 60 * 60;
/**
 * Every Goal Loop turn's prompt repeats every acceptance item for the life of the run
 * (see extensions/leafcode-goal-loop/index.ts acceptanceText()), which trusts its caller
 * to have already bounded this list. Four independent start endpoints duplicated this
 * check; one (bots/[id]/prompt) drifted to no bound at all before being fixed to match
 * the others. Use this shared helper for any new or changed entry point instead of a
 * fifth copy.
 */
export const MAX_GOAL_LOOP_ACCEPTANCE_ITEMS = 10;
export const MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS = 2_000;

/** Statuses where a live turn or verification is still owned by the loop. */
export const GOAL_LOOP_LIVE_STATUSES = ["queued", "running", "verifying_completed"];
/** Live plus the operator holds (paused / blocked) that Resume/Stop can still act on. */
const GOAL_LOOP_OWNED_STATUSES = [...GOAL_LOOP_LIVE_STATUSES, "paused", "blocked"];

export function isGoalLoopLiveStatus(status) {
  return Boolean(status && GOAL_LOOP_LIVE_STATUSES.includes(status));
}

export function isGoalLoopSessionOwnedStatus(status) {
  return Boolean(status && GOAL_LOOP_OWNED_STATUSES.includes(status));
}

/**
 * queued の次に送信されるターン番号。エラーで中断されたターンは再開時に同じ番号を
 * 再送するため、ターン枠を消費した表示（turnCount + 1）にしない。
 */
export function nextGoalLoopTurn(loop) {
  const turnCount = Math.max(0, Math.trunc(Number(loop.turnCount) || 0));
  return loop.status === "queued" && loop.retryInterruptedTurn !== true ? turnCount + 1 : turnCount;
}

/** Zero is the explicit no-limit sentinel. */
export function normalizeGoalLoopMaxTurns(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(MAX_GOAL_LOOP_TURNS, Math.max(0, Math.trunc(number)));
}

export function clampGoalLoopMaxTurns(value, fallback = DEFAULT_GOAL_LOOP_MAX_TURNS) {
  return normalizeGoalLoopMaxTurns(value) ?? fallback;
}

/**
 * Trim, drop blank entries, and bound an acceptance-criteria list.
 * Returns null when the shape, count, or an item's length is invalid so callers can
 * reject the request; an absent list normalizes to `[]`, not null.
 */
export function normalizeGoalLoopAcceptance(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_GOAL_LOOP_ACCEPTANCE_ITEMS) return null;
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const text = item.trim();
    if (text.length > MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS) return null;
    if (text) result.push(text);
  }
  return result;
}

const DURATION_TOKEN = /(\d+(?:\.\d+)?)\s*([smhd])/gi;

export function parseGoalLoopCooldownSeconds(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS;
  const text = value.trim();
  if (!text) return DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return Number(text);

  DURATION_TOKEN.lastIndex = 0;
  let cursor = 0;
  let total = 0;
  let matched = false;
  let token;
  while ((token = DURATION_TOKEN.exec(text))) {
    if (text.slice(cursor, token.index).trim()) return DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS;
    const unit = token[2].toLowerCase();
    const multiplier = unit === "d" ? 24 * 60 * 60 : unit === "h" ? 60 * 60 : unit === "m" ? 60 : 1;
    total += Number(token[1]) * multiplier;
    cursor = DURATION_TOKEN.lastIndex;
    matched = true;
  }
  return matched && !text.slice(cursor).trim()
    ? total
    : DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS;
}

export function clampGoalLoopCooldownSeconds(value) {
  const number = parseGoalLoopCooldownSeconds(value);
  if (!Number.isFinite(number)) return DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS;
  return Math.min(MAX_GOAL_LOOP_COOLDOWN_SECONDS, Math.max(0, Math.trunc(number)));
}

export function formatGoalLoopCooldownSeconds(value) {
  const seconds = clampGoalLoopCooldownSeconds(value);
  if (seconds === 0) return "0";
  const parts = [];
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

/**
 * Whether a Goal Loop command is a control action (pause/stop/complete). Control actions must
 * still reach the session after an abort bumped the prompt generation, otherwise the on-disk
 * Goal Loop would stay live while the API reported success.
 */
export function isGoalLoopControlAction(action) {
  return action === "pause" || action === "stop" || action === "complete";
}

/**
 * Whether a stale start/resume must roll back what it prepared. `prepareLiveForPrompt` may have
 * marked the task working and taken the lease before the generation turned stale; that is only
 * rolled back while this worker still owns the lease and nothing is running, so a real turn
 * that started in the meantime keeps its status.
 */
export function shouldRollbackStaleGoalPrepare({
  isStartOrResume,
  ownsLease,
  taskStatus,
  promptActive,
  isStreaming,
  isCompacting,
}) {
  return (
    isStartOrResume === true &&
    ownsLease === true &&
    taskStatus === "working" &&
    promptActive !== true &&
    isStreaming !== true &&
    isCompacting !== true
  );
}
