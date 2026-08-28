import {
  clampThinkingLevel as piClampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@/lib/types";

export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

// Model-baseline English labels shown verbatim in the effort dropdown / meta line.
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export const THINKING_LEVEL_STORAGE_KEY = "leafcodepi.thinkingLevel";

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (ALL_THINKING_LEVELS as readonly string[]).includes(value);
}

export function readStoredThinkingLevel(): ThinkingLevel | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const value = localStorage.getItem(THINKING_LEVEL_STORAGE_KEY);
    return isThinkingLevel(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredThinkingLevel(level: ThinkingLevel): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(THINKING_LEVEL_STORAGE_KEY, level);
  } catch {
    /* ignore */
  }
}

/**
 * Levels the model actually accepts (Pi `getSupportedThinkingLevels`).
 * `off` はプロバイダ側で明示定義（thinkingLevelMap.off に値）がある場合のみ選択肢に残す。
 */
export function thinkingLevelsForModel(model: Model<Api>): ThinkingLevel[] {
  const levels = getSupportedThinkingLevels(model).filter(isThinkingLevel);
  return model.thinkingLevelMap?.off !== undefined ? levels : levels.filter((l) => l !== "off");
}

/** 既定 effort: medium 固定。非対応なら最も近いレベル（同距離は安い方）。 */
export function defaultThinkingLevel(levels: readonly ThinkingLevel[]): ThinkingLevel {
  if (levels.includes("medium")) return "medium";
  const mid = ALL_THINKING_LEVELS.indexOf("medium");
  const rank = (level: ThinkingLevel) => Math.abs(ALL_THINKING_LEVELS.indexOf(level) - mid);
  return [...levels].sort((a, b) => rank(a) - rank(b) || ALL_THINKING_LEVELS.indexOf(a) - ALL_THINKING_LEVELS.indexOf(b))[0] ?? "off";
}

export function resolveThinkingLevel(
  levels: readonly ThinkingLevel[],
  preferred: unknown,
): ThinkingLevel {
  return isThinkingLevel(preferred) && levels.includes(preferred)
    ? preferred
    : defaultThinkingLevel(levels);
}

export function clampThinkingLevelForModel(
  model: Model<Api>,
  level: ThinkingLevel | string | undefined,
): ThinkingLevel {
  const requested = isThinkingLevel(level) ? level : "off";
  const clamped = piClampThinkingLevel(model, requested);
  return isThinkingLevel(clamped) ? clamped : "off";
}

export function thinkingLevelLabel(level: ThinkingLevel | string | undefined): string {
  if (isThinkingLevel(level)) return THINKING_LEVEL_LABELS[level];
  return "effort";
}
