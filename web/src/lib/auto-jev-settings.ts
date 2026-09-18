export const AUTO_JEV_ENABLED_SETTING_KEY = "auto-jev-enabled";
export const AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY = "auto-jev-min-confidence";

export const DEFAULT_AUTO_JEV_ENABLED = false;
export const DEFAULT_AUTO_JEV_MIN_CONFIDENCE = 0.6;
export const AUTO_JEV_MIN_CONFIDENCE_VALUES = [
  0.5,
  0.55,
  0.6,
  0.65,
  0.7,
  0.75,
  0.8,
  0.85,
  0.9,
  0.95,
] as const;

export function isAutoJevEnabled(value: string | null | undefined): boolean {
  return value === "1";
}

export function isAutoJevMinConfidence(value: number): boolean {
  return AUTO_JEV_MIN_CONFIDENCE_VALUES.includes(
    value as (typeof AUTO_JEV_MIN_CONFIDENCE_VALUES)[number],
  );
}

export function parseAutoJevMinConfidence(value: string | null | undefined): number {
  const parsed = Number(value);
  return isAutoJevMinConfidence(parsed) ? parsed : DEFAULT_AUTO_JEV_MIN_CONFIDENCE;
}
