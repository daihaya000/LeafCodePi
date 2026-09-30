export const SOUL_TEMPLATE: string;
export const DEFAULT_SKILLS: BotSkillsConfig;

import type { BotDto, BotSkillsConfig, BotToolName } from "@shared/types";

export type BotPermissionMode = "allow" | "ask" | "deny";
export type { BotSkillsConfig };

/**
 * The persisted bot record: the shared DTO without the derived `soul`, with the
 * raw (possibly unknown-name carrying) tool allowlist.
 */
export type BotConfig = Omit<BotDto, "soul" | "tools"> & { label: string; tools: string[] };

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
