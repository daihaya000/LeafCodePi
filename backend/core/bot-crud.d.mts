import type { BotConfig, BotPermissionMode } from "./bot-config.mjs";
import type { ThinkingLevel } from "@shared/types";

export function createBotConfig(input: {
  id: string;
  name?: string | null;
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  permissionMode?: BotPermissionMode | null;
  now: string;
  defaultToolNames: readonly string[];
}): BotConfig;

export type BotConfigPatch = Omit<Partial<BotConfig>, "avatarEyeColor"> & {
  /** SOUL.md content; applied to the file and never stored in config. */
  soul?: string;
  avatarEyeColor?: string | null | undefined;
};

export function applyBotConfigPatch(
  current: BotConfig,
  patch: BotConfigPatch,
  options: { now: string },
): BotConfig;
