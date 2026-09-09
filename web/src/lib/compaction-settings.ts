export const COMPACTION_ACTION_SETTING_KEY = "compactionAction";
export const COMPACTION_THRESHOLD_SETTING_KEY = "compactionThreshold";

export type CompactionAction = "suggest" | "auto" | "off";

export function parseCompactionAction(value: string | null): CompactionAction {
  return value === "auto" || value === "off" || value === "suggest" ? value : "auto";
}

export function parseCompactionThreshold(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 70 && parsed <= 95 ? parsed : 80;
}

export function shouldCompactAtThreshold(
  action: CompactionAction,
  percent: number | null | undefined,
  threshold: number,
): boolean {
  return action === "auto" &&
    typeof percent === "number" &&
    Number.isFinite(percent) &&
    percent >= threshold;
}

/** Convert a percentage threshold into Pi's reserved-token boundary. */
export function reserveTokensForThreshold(
  contextWindow: number,
  threshold: number,
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.max(1, Math.ceil((contextWindow * (100 - threshold)) / 100));
}
