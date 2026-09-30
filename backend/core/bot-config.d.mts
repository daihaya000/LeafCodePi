export const SOUL_TEMPLATE: string;
export const DEFAULT_SKILLS: BotSkillsConfig;

import type { BotAvatarColor, BotAvatarShape } from "./bot-avatar.mjs";
import type { BotSkillsConfig, BotToolName, ThinkingLevel } from "@shared/types";

export type BotPermissionMode = "allow" | "ask" | "deny";
export type { BotSkillsConfig };

/** The persisted bot record, as read back and normalized. */
export type BotConfig = {
  id: string;
  name: string;
  label: string;
  avatarColor: BotAvatarColor;
  avatarImage: string | null;
  avatarShape: BotAvatarShape;
  avatarEyeColor?: string;
  avatarGlasses: boolean;
  avatarMustache: boolean;
  createdAt: string;
  updatedAt: string;
  model: string | null;
  ttsVoice: string | null;
  thinkingLevel: ThinkingLevel | null;
  permissionMode: BotPermissionMode;
  skills: BotSkillsConfig;
  tools: string[];
  extraRoots: string[];
  enabled: boolean;
  notificationsEnabled: boolean;
  intercomEnabled: boolean;
  intercomScopeId: string;
  intercomFanoutEnabled: boolean;
  codeAutoApprove: boolean;
  codeSessionTaskId: string | null;
};

export function legacyDefaultToolSets(toolNames: readonly string[]): string[][];
export function shouldMigrateBotTools(value: unknown, raw: readonly string[], toolNames: readonly string[]): boolean;
export function normalizeBotTools(value: unknown, defaultToolNames: readonly string[]): string[];
export function isBotToolName(name: string, toolNames: readonly string[]): boolean;
export function normalizeBotPermissionMode(value: unknown): BotPermissionMode;
export function normalizeNames(value: unknown): string[];
export function normalizeBotSkills(value: unknown): BotSkillsConfig;

export function parseBotConfig(options: {
  id: string;
  readText: () => string;
  /** Called with the migrated config when the stored record is legacy. */
  writeConfig: (config: BotConfig) => void;
  toolNames: readonly string[];
  defaultToolNames: readonly string[];
}): BotConfig | null;

export function toBotDto<T extends { tools: string[] }>(
  config: T,
  options: { readSoulText: () => string; toolNames: readonly string[] },
): Omit<T, "tools"> & { tools: BotToolName[]; soul: string };
