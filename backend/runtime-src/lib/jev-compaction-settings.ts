export const JEV_COMPACTION_ENABLED_SETTING_KEY = "jev-compaction-enabled";
export const JEV_COMPACTION_THRESHOLD_SETTING_KEY = "jev-compaction-threshold";
export const DEFAULT_JEV_COMPACTION_THRESHOLD = 0.6;

export function isJevCompactionEnabled(value: string | null | undefined): boolean {
  return value === "1";
}

export function parseJevCompactionThreshold(value: string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 0.95
    ? parsed
    : DEFAULT_JEV_COMPACTION_THRESHOLD;
}
