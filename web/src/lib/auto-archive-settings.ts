export const AUTO_ARCHIVE_DAYS_SETTING_KEY = "auto-archive-days";
export const DEFAULT_AUTO_ARCHIVE_DAYS = 14;
export const AUTO_ARCHIVE_DAY_OPTIONS = ["off", "7", "14", "30", "90", "180", "365"] as const;

export type AutoArchiveDaysOption = (typeof AUTO_ARCHIVE_DAY_OPTIONS)[number];

export function isAutoArchiveDaysOption(value: unknown): value is AutoArchiveDaysOption {
  return AUTO_ARCHIVE_DAY_OPTIONS.some((option) => option === value);
}

/** Missing uses the default; invalid values fail closed. */
export function parseAutoArchiveDays(value: string | null): number | null {
  if (value === null) return DEFAULT_AUTO_ARCHIVE_DAYS;
  return isAutoArchiveDaysOption(value) && value !== "off" ? Number(value) : null;
}
