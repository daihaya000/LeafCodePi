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

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (ALL_THINKING_LEVELS as readonly string[]).includes(value);
}

/** Levels the model actually accepts (Pi `getSupportedThinkingLevels`). */
export function thinkingLevelsForModel(model: Model<Api>): ThinkingLevel[] {
  return getSupportedThinkingLevels(model).filter(isThinkingLevel);
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
