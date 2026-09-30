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
import { applyBotConfigPatch as coreApplyBotConfigPatch, createBotConfig as coreCreateBotConfig } from "@backend-core/bot-crud.mjs";

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

function writeConfig(config: BotConfig): void { botFileStore.writeConfig(config); }
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
export function createBot(input: { name?: string; model?: string | null; thinkingLevel?: ThinkingLevel | null; permissionMode?: BotConfig["permissionMode"] }): BotDto {
  const id = randomUUID();
  // Defaults live in backend core; the file/task side effects stay here.
  const config: BotConfig = coreCreateBotConfig({
    id,
    name: input.name,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    permissionMode: input.permissionMode,
    now: new Date().toISOString(),
    defaultToolNames: BOT_DEFAULT_TOOL_NAMES,
  });
  const name = config.name;
  mkdirSync(botFileStore.workspacePath(id), { recursive: true });
  botFileStore.writeSoul(id, SOUL_TEMPLATE);
  botFileStore.ensureMemoryFile(id);
  writeConfig(config);
  insertBotTask({ id: `bot:${id}`, botId: id, name, directory: botFileStore.workspacePath(id), model: config.model, thinkingLevel: config.thinkingLevel, permissionMode: config.permissionMode });
  return toDto(config);
}
export function patchBot(id: string, patch: Partial<Pick<BotConfig, "name" | "label" | "avatarColor" | "avatarImage" | "avatarShape" | "avatarGlasses" | "avatarMustache" | "model" | "ttsVoice" | "thinkingLevel" | "permissionMode" | "skills" | "tools" | "extraRoots" | "enabled" | "notificationsEnabled" | "intercomEnabled" | "intercomScopeId" | "intercomFanoutEnabled" | "codeAutoApprove" | "codeSessionTaskId">> & { soul?: string; avatarEyeColor?: string | null }): BotDto | undefined {
  const current = parseConfig(id); if (!current) return undefined;
  // Merge rules (voice trimming, eye-colour validation, SOUL stripping) live in backend core.
  const next: BotConfig = coreApplyBotConfigPatch(current, patch, { now: new Date().toISOString() });
  writeConfig(next);
  if (patch.soul !== undefined) botFileStore.writeSoul(id, patch.soul);
  // Model routing is applied by the bot PATCH route through setTaskModel; do not write the logical model key into modelID.
  patchTask(`bot:${id}`, { title: next.name, thinkingLevel: next.thinkingLevel ?? undefined, permissionMode: next.permissionMode ?? undefined });
  return toDto(next);
}
export function deleteBot(id: string): boolean {
  if (!parseConfig(id)) return false;
  // Removes the 1:1 task, Room sessions, and any Bot-owned Code tasks left after API teardown.
  for (const task of listTasks(true, "all")) {
    if (task.botId === id) deleteTask(task.id);
    else if (task.supervisorBotId === id) patchTask(task.id, { supervisorBotId: null });
  }
  botFileStore.removeBot(id); return true;
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
