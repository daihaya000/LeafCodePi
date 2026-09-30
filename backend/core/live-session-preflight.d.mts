import type { BotPermissionMode } from "./bot-config.mjs";

export type LiveSessionRefusal = "task-not-found" | "archived" | "lease-busy";

export const TASK_NOT_FOUND_MESSAGE: string;
export const TASK_ARCHIVED_MESSAGE: string;

/** Status and message for a refusal; the lease wording is injected. */
export function liveSessionRefusalError(
  refusal: LiveSessionRefusal | null,
  options: { leaseBusyMessage: string },
): { status: number; message: string };

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

/**
 * Where a session's starting thinking level comes from: the stored task level, the
 * model default, or nothing (no model).
 */
export function resolveSessionThinkingLevelSource(input: {
  hasStoredLevel: boolean;
  hasModel: boolean;
}): "stored" | "model-default" | "none";

/**
 * How a stored model resolved: it loaded, Auto replaced it for this session only,
 * or it is unavailable (the caller maps that to 503).
 */
export function resolveStoredModelOutcome(input: {
  hasStoredModel: boolean;
  resolved: boolean;
  autoFallback: boolean;
}): "resolved" | "auto-fallback" | "unavailable";

/** "account-not-found" (404) / "account-paused" (409) for an explicit account, else null. */
export function resolveSessionAccountRefusal(input: {
  explicit: boolean;
  hasTaskAccountId: boolean;
  hasAccountRecord: boolean;
  accountEnabled: boolean;
}): "account-not-found" | "account-paused" | null;

/** The account a new session uses: route account, else a usable task account, else null. */
export function resolveSessionAccountId(input: {
  modelRouteAccountId?: string | null;
  taskAccountId?: string | null;
  hasAccountRecord: boolean;
  accountEnabled: boolean;
  hasProviderId: boolean;
  routedThroughAccounts: boolean;
  accountHasProvider: boolean;
}): string | null;

/** A Bot task is a Bot session only when it also carries the Bot it belongs to. */
export function isBotTask(task: { kind?: string | null; botId?: string | null } | undefined): boolean;

/** The registered project's root, or the task's own directory. */
export function liveSessionWorkspace(input: {
  projectRootPath?: string | null;
  taskDirectory: string;
}): string;

/** Bot sessions are namespaced as `bot:<title>`. */
export function liveSessionName(input: { isBot: boolean; title: string }): string;

/** A freshly normalized skill permission wins over the stored one. */
export function resolveSessionSkillPermission(input: {
  updatedSkillPermission?: "allow" | "deny" | null;
  taskSkillPermission?: "allow" | "deny" | null;
}): "allow" | "deny" | undefined;
