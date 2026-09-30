import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./paths";
import { globalBotsMdPath, globalUserMdPath } from "./agents-md";
import { basenameKey, isWebUiRequiredExtension } from "./extensions";
import { deleteTask, insertBotTask, listTasks, patchTask } from "./store";
import { BOT_DEFAULT_TOOL_NAMES, BOT_TOOL_NAMES, type BotDto, type ThinkingLevel } from "./types";
import { isAvatarEyeColor, randomAvatarColor } from "./bot-avatar";
import { DEFAULT_SKILLS, parseBotConfig, SOUL_TEMPLATE, toBotDto } from "@backend-core/bot-config.mjs";

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

function botsRoot(): string { return join(dataDir(), "bots"); }
function assertId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) throw new Error("invalid bot id");
}
function botRoot(id: string): string { assertId(id); return join(botsRoot(), id); }
function configPath(id: string): string { return join(botRoot(id), "config.json"); }
function soulPath(id: string): string { return join(botRoot(id), "SOUL.md"); }
function memoryPath(id: string): string { return join(botRoot(id), "MEMORY.md"); }
function ensureMemoryFile(id: string): void {
  const file = memoryPath(id);
  if (!existsSync(file)) writeFileSync(file, "# Bot memory\n\n", "utf8");
}
function writeConfig(config: BotConfig): void {
  mkdirSync(botRoot(config.id), { recursive: true });
  const target = configPath(config.id);
  const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}
function parseConfig(id: string): BotConfig | null {
  // Normalization and one-time legacy migration live in backend core.
  return parseBotConfig({
    id,
    readText: () => readFileSync(configPath(id), "utf8"),
    writeConfig: (config) => writeConfig(config),
    toolNames: BOT_TOOL_NAMES,
    defaultToolNames: BOT_DEFAULT_TOOL_NAMES,
  });
}function toDto(config: BotConfig): BotDto {
  return toBotDto(config, { readSoulText: () => readFileSync(soulPath(config.id), "utf8"), toolNames: BOT_TOOL_NAMES });
}
export function listBots(): BotDto[] {
  if (!existsSync(botsRoot())) return [];
  return readdirSync(botsRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => parseConfig(entry.name))
    .filter((config): config is BotConfig => Boolean(config))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(toDto);
}
export function getBot(id: string): BotDto | undefined {
  const config = parseConfig(id);
  return config ? toDto(config) : undefined;
}
export function createBot(input: { name?: string; model?: string | null; thinkingLevel?: ThinkingLevel | null; permissionMode?: BotConfig["permissionMode"] }): BotDto {
  const name = input.name?.trim() || "New bot";
  const id = randomUUID(); const now = new Date().toISOString();
  const config: BotConfig = { id, name, label: "", avatarColor: randomAvatarColor(), avatarImage: null, avatarShape: "circle", avatarGlasses: false, avatarMustache: false, createdAt: now, updatedAt: now, model: input.model ?? null, ttsVoice: null, thinkingLevel: input.thinkingLevel ?? null, permissionMode: input.permissionMode ?? "allow", codeAutoApprove: true, skills: { ...DEFAULT_SKILLS }, tools: [...BOT_DEFAULT_TOOL_NAMES], extraRoots: [], enabled: true, notificationsEnabled: true, intercomEnabled: false, intercomScopeId: "", intercomFanoutEnabled: false, codeSessionTaskId: null };
  mkdirSync(join(botRoot(id), "workspace"), { recursive: true });
  writeFileSync(soulPath(id), SOUL_TEMPLATE, "utf8");
  ensureMemoryFile(id);
  writeConfig(config);
  insertBotTask({ id: `bot:${id}`, botId: id, name, directory: join(botRoot(id), "workspace"), model: config.model, thinkingLevel: config.thinkingLevel, permissionMode: config.permissionMode });
  return toDto(config);
}
export function patchBot(id: string, patch: Partial<Pick<BotConfig, "name" | "label" | "avatarColor" | "avatarImage" | "avatarShape" | "avatarGlasses" | "avatarMustache" | "model" | "ttsVoice" | "thinkingLevel" | "permissionMode" | "skills" | "tools" | "extraRoots" | "enabled" | "notificationsEnabled" | "intercomEnabled" | "intercomScopeId" | "intercomFanoutEnabled" | "codeAutoApprove" | "codeSessionTaskId">> & { soul?: string; avatarEyeColor?: string | null }): BotDto | undefined {
  const current = parseConfig(id); if (!current) return undefined;
  // null clears the eye color back to the automatic default.
  const ttsVoice = patch.ttsVoice === undefined ? current.ttsVoice : (typeof patch.ttsVoice === "string" && patch.ttsVoice.trim() ? patch.ttsVoice.trim() : null);
  const next: BotConfig = { ...current, ...patch, ttsVoice, avatarEyeColor: patch.avatarEyeColor === undefined ? current.avatarEyeColor : (isAvatarEyeColor(patch.avatarEyeColor) ? patch.avatarEyeColor : undefined), skills: patch.skills ?? current.skills, updatedAt: new Date().toISOString() };
  delete (next as Record<string, unknown>).soul;
  writeConfig(next);
  if (patch.soul !== undefined) writeFileSync(soulPath(id), patch.soul, "utf8");
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
  rmSync(botRoot(id), { recursive: true, force: true }); return true;
}
export function botWorkspace(id: string): string { return join(botRoot(id), "workspace"); }
export function botSoul(id: string): string { return readFileSync(soulPath(id), "utf8"); }
/** Lightweight revision used to notice SOUL edits made by another worker. */
export function botSoulRevision(id: string): string | null {
  try {
    const stat = statSync(soulPath(id));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}
export function botTaskId(id: string): string { return `bot:${id}`; }
/** Runtime facts are separate from BOTS.md/SOUL.md and never import global AGENTS.md. */
export function botRuntimeContext(extensions: readonly { path: string }[]): string {
  return [
    "<runtime_context>",
    "You are running inside LeafCodePi Bot, using the Pi SDK and LeafCode extensions, not a standalone chatbot.",
    "Resolve omitted details from the current request, conversation, and available evidence before asking the user. State a reasonable working assumption briefly and proceed with requested work. Ask only when unresolved ambiguity would materially change the target, outcome, or safety.",
    "Requests to debug or improve this application's Bot mode target LeafCodePi, unless the user or established conversation identifies another project. The Bot workspace is not the application's source repository.",
    "For repository work, use code_session projects to find the matching registered projectId yourself; do not ask the user to pick a project when the target is clear. Never invent a projectId or silently substitute a projectless workspace when the intended project cannot be found; ask a focused question instead. When Code must see a screenshot the user sent in this chat, pass code_session images as 1-based indexes from projects/status availableImages. Omit images to attach the latest user message's images; pass [] to attach none.",
    "Unless the user explicitly requests a demonstration, a debug-loop request without a named symptom means an exploratory bug hunt, not a demonstration: delegate to Code to inspect the relevant flows, reproduce, diagnose, fix, test, and recheck until the goal is met or a concrete blocker is found. Use goalLoop for a multi-turn run and report actual evidence, not just its launch.",
    "Inferred context does not authorize changes during a consultation or bypass approval, permission, or workspace boundaries.",
    "Use update_soul only when the user explicitly asks you to change your own SOUL.md; it cannot edit any other file or another Bot's SOUL.md.",
    "Loaded extensions (not a list of currently callable tools):",
    ...extensions.map(({ path }) => {
      const name = basenameKey(path);
      return JSON.stringify({ name, path, requiredByLeafCode: isWebUiRequiredExtension(name) });
    }),
    "LeafCode-required extensions are application dependencies; do not disable or remove them.",
    "The available_skills section is the session's filtered skill inventory. Skills may be bundled under extensions/*/skills, not only ~/.pi/agent/skills. Read the listed SKILL.md before using a skill.",
    "Use tool_search to find an optional capability before claiming it is unavailable. Permitted tools can be called directly when listed; loaded extensions do not grant tool permissions. Honor Bot skill restrictions and do not reinstall bundled features merely because their tools are not currently visible.",
    "Use jev_judge when a task needs semantic selection, ranking, or verification. Ask narrow typed questions (noul/choice/score), include a no-match choice when appropriate, and treat low confidence as uncertainty. Jev does not generate text or code, and its answer alone never authorizes irreversible actions.",
    "</runtime_context>",
  ].join("\n");
}

// Bot instructions and memory come from BOTS.md/USER.md/SOUL.md/MEMORY.md, never global AGENTS.md.
// Global SOUL.md is Code-only; each bot uses its own SOUL.md instead.
// Return paths so session.reload() re-reads edits without a new session.
export function botPromptSources(id: string): string[] {
  ensureMemoryFile(id);
  const sources: string[] = [];
  const shared = globalBotsMdPath();
  if (existsSync(shared)) sources.push(shared);
  const user = globalUserMdPath();
  if (existsSync(user)) sources.push(user);
  sources.push(soulPath(id));
  // MEMORY.md is re-read when a session is created, so facts learned in a
  // previous conversation become context without copying them into config.json.
  if (existsSync(memoryPath(id))) sources.push(memoryPath(id));
  return sources;
}
