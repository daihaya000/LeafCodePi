export const COMPACTION_ACTION_SETTING_KEY = "compactionAction";
export const COMPACTION_THRESHOLD_SETTING_KEY = "compactionThreshold";

export type CompactionAction = "suggest" | "auto" | "off";

export function parseCompactionAction(value: string | null): CompactionAction {
  return value === "auto" || value === "off" ? value : "suggest";
}

export function parseCompactionThreshold(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 70 && parsed <= 95 ? parsed : 80;
}
