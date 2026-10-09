import {
  clampThinkingLevel as piClampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";


/**
 * Levels the model actually accepts (Pi `getSupportedThinkingLevels`).
 * `off` はプロバイダ側で明示定義（thinkingLevelMap.off に値）がある場合のみ選択肢に残す。
 */
export function thinkingLevelsForModel(model: Model<Api>): ThinkingLevel[] {
  const levels = getSupportedThinkingLevels(model).filter(isThinkingLevel);
  return model.thinkingLevelMap?.off !== undefined ? levels : levels.filter((l) => l !== "off");
}


export function clampThinkingLevelForModel(
  model: Model<Api>,
  level: ThinkingLevel | string | undefined,
): ThinkingLevel {
  const requested = isThinkingLevel(level) ? level : "off";
  const clamped = piClampThinkingLevel(model, requested);
  return isThinkingLevel(clamped) ? clamped : "off";
}
import { isThinkingLevel } from "@shared/ui/thinking-levels";
import type { ThinkingLevel } from "@shared/types";
export * from "@shared/ui/thinking-levels";
