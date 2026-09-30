import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./paths";
import { globalBotsMdPath, globalUserMdPath } from "./agents-md";
import { deleteTask, insertBotTask, listTasks, patchTask } from "./store";
import { BOT_DEFAULT_TOOL_NAMES, BOT_TOOL_NAMES, type BotDto, type ThinkingLevel } from "./types";

import { SOUL_TEMPLATE, toBotDto } from "@backend-core/bot-config.mjs";
import { BotFileStore } from "@backend-core/bot-store.mjs";
import { botRuntimeContext as coreBotRuntimeContext } from "@backend-core/bot-runtime-context.mjs";
import { createBotWithEffects, deleteBotWithEffects, patchBotWithEffects } from "@backend-core/bot-lifecycle.mjs";

export type BotConfig = Omit<BotDto, "soul" | "tools"> & { label: string; tools: string[] };
/** Repeated in Room roster/identity JSON every turn (see room-conversation.ts); keep it short. */
export const MAX_BOT_NAME_CHARS = 100;
export const MAX_BOT_LABEL_CHARS = 100;

/**
 * Count code points, not UTF-16 units, so an emoji costs one character the way it reads.
 * Matches isPromptTextWithinSize() and the agent/routine bounds; a bare `.length` would
 * make the effective limit half the documented one for astral-plane names.
 */
export { normalizeBotSkills } from "@backend-core/bot-config.mjs";
export function isBotNameWithinSize(value: string): boolean {
  return Array.from(value).length <= MAX_BOT_NAME_CHARS;
}

export function isBotLabelWithinSize(value: string): boolean {
  return Array.from(value).length <= MAX_BOT_LABEL_CHARS;
}
export { BOT_DEFAULT_TOOL_NAMES, BOT_TOOL_NAMES };

// Bot files live in backend core; the paths, tool vocabulary and task side effects
// stay here as injected hooks.
const botFileStore = new BotFileStore({
  botsRoot: () => join(dataDir(), "bots"),
  toolNames: BOT_TOOL_NAMES,
  defaultToolNames: BOT_DEFAULT_TOOL_NAMES,
});

function parseConfig(id: string): BotConfig | null { return botFileStore.readConfig(id); }
function toDto(config: BotConfig): BotDto {
  return toBotDto(config, { readSoulText: () => botFileStore.readSoulText(config.id), toolNames: BOT_TOOL_NAMES });
}
export function listBots(): BotDto[] {
  return botFileStore.listConfigs().map(toDto);
}
export function getBot(id: string): BotDto | undefined {
  const config = parseConfig(id);
  return config ? toDto(config) : undefined;
}
/** Side effects live in backend core; the file store, task store and clock are injected. */
function botLifecycleDeps() {
  return {
    store: botFileStore,
    tasks: { insertBotTask, patchTask, deleteTask, listTasks },
    defaultToolNames: BOT_DEFAULT_TOOL_NAMES,
    soulTemplate: SOUL_TEMPLATE,
    ensureWorkspace: (directory: string) => mkdirSync(directory, { recursive: true }),
    toDto,
    uuid: () => randomUUID(),
    now: () => new Date().toISOString(),
  };
}

export function createBot(input: { name?: string; model?: string | null; thinkingLevel?: ThinkingLevel | null; permissionMode?: BotConfig["permissionMode"] }): BotDto {
  return createBotWithEffects(input, botLifecycleDeps());
}
export function patchBot(id: string, patch: Partial<Pick<BotConfig, "name" | "label" | "avatarColor" | "avatarImage" | "avatarShape" | "avatarGlasses" | "avatarMustache" | "model" | "ttsVoice" | "thinkingLevel" | "permissionMode" | "skills" | "tools" | "extraRoots" | "enabled" | "notificationsEnabled" | "intercomEnabled" | "intercomScopeId" | "intercomFanoutEnabled" | "codeAutoApprove" | "codeSessionTaskId">> & { soul?: string; avatarEyeColor?: string | null }): BotDto | undefined {
  return patchBotWithEffects(id, patch, botLifecycleDeps());
}
export function deleteBot(id: string): boolean {
  return deleteBotWithEffects(id, botLifecycleDeps());
}
export function botWorkspace(id: string): string { return botFileStore.workspacePath(id); }
export function botSoul(id: string): string { return botFileStore.readSoulText(id); }
/** Lightweight revision used to notice SOUL edits made by another worker. */
export function botSoulRevision(id: string): string | null {
  return botFileStore.soulRevision(id);
}
export function botTaskId(id: string): string { return `bot:${id}`; }
/** Runtime facts are separate from BOTS.md/SOUL.md and never import global AGENTS.md. */
export function botRuntimeContext(extensions: readonly { path: string }[]): string {
  return coreBotRuntimeContext(extensions);
}
// Bot instructions and memory come from BOTS.md/USER.md/SOUL.md/MEMORY.md, never global AGENTS.md.
// Global SOUL.md is Code-only; each bot uses its own SOUL.md instead.
// Return paths so session.reload() re-reads edits without a new session.
export function botPromptSources(id: string): string[] {
  botFileStore.ensureMemoryFile(id);
  const sources: string[] = [];
  const shared = globalBotsMdPath();
  if (existsSync(shared)) sources.push(shared);
  const user = globalUserMdPath();
  if (existsSync(user)) sources.push(user);
  sources.push(botFileStore.soulPath(id));
  // MEMORY.md is re-read when a session is created, so facts learned in a
  // previous conversation become context without copying them into config.json.
  if (existsSync(botFileStore.memoryPath(id))) sources.push(botFileStore.memoryPath(id));
  return sources;
}
