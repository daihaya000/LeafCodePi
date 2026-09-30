import type { BotPermissionMode } from "./bot-config.mjs";

export type LiveSessionRefusal = "task-not-found" | "archived" | "lease-busy";

/**
 * Which refusal applies (task-not-found → archived → lease-busy), or null when a
 * session may be created.
 */
export function preflightLiveSession(input: {
  hasTask: boolean;
  status: string;
  leaseHeldElsewhere: boolean;
}): LiveSessionRefusal | null;

/** Bot sessions follow the bot record; Code sessions use the normalized task value. */
export function resolveSessionPermissionMode(input: {
  isBot: boolean;
  botPermissionMode: BotPermissionMode | null | undefined;
  updatedPermissionMode: BotPermissionMode | null | undefined;
  taskPermissionMode: BotPermissionMode | null | undefined;
}): BotPermissionMode | undefined;
