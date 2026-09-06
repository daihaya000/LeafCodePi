import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dataDir } from "./paths";
import { deleteTask, insertBotTask, listTasks, patchTask } from "./store";
import type { BotDto, BotSkillsConfig, ThinkingLevel } from "./types";
import { avatarColorForId, isAvatarColor, isAvatarImage, randomAvatarColor } from "./bot-avatar";

export type BotConfig = Omit<BotDto, "soul">;
const SOUL_TEMPLATE = `# ボットの役割\n\nあなたは専属の1対1アシスタントです。\n\n## 方針\n- 簡潔で役に立つ回答をしてください。\n- 明示的に許可されていない限り、ファイル操作は workspace/ 内で行ってください。\n`;
const DEFAULT_SKILLS: BotSkillsConfig = { mode: "inherit", include: [], exclude: [] };

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

export function normalizeBotSkills(value: unknown): BotSkillsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_SKILLS };
  const candidate = value as Record<string, unknown>;
  const mode = candidate.mode === "include" || candidate.mode === "exclude" ? candidate.mode : "inherit";
  return { mode, include: normalizeNames(candidate.include), exclude: normalizeNames(candidate.exclude) };
}

function botsRoot(): string { return join(dataDir(), "bots"); }
function assertId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) throw new Error("invalid bot id");
}
function botRoot(id: string): string { assertId(id); return join(botsRoot(), id); }
function configPath(id: string): string { return join(botRoot(id), "config.json"); }
function soulPath(id: string): string { return join(botRoot(id), "SOUL.md"); }
function writeConfig(config: BotConfig): void {
  mkdirSync(botRoot(config.id), { recursive: true });
  writeFileSync(configPath(config.id), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
function parseConfig(id: string): BotConfig | null {
  try {
    const value = JSON.parse(readFileSync(configPath(id), "utf8")) as Partial<BotConfig>;
    if (value.id !== id || typeof value.name !== "string") return null;
    const avatarColor = isAvatarColor(value.avatarColor) ? value.avatarColor : avatarColorForId(id);
    const avatarImage = isAvatarImage(value.avatarImage) ? value.avatarImage : null;
    const config: BotConfig = {
      id, name: value.name, avatarColor, avatarImage, createdAt: String(value.createdAt), updatedAt: String(value.updatedAt),
      model: typeof value.model === "string" ? value.model : null,
      thinkingLevel: value.thinkingLevel ?? null, permissionMode: value.permissionMode ?? null,
      skills: normalizeBotSkills(value.skills),
      extraRoots: Array.isArray(value.extraRoots) ? value.extraRoots.filter((item): item is string => typeof item === "string") : [],
      enabled: value.enabled !== false,
    };
    // Migrate legacy bots once, keeping the fallback stable for every subsequent read.
    if (!isAvatarColor(value.avatarColor)) writeConfig(config);
    return config;
  } catch { return null; }
}
function toDto(config: BotConfig): BotDto {
  let soul = SOUL_TEMPLATE;
  try { soul = readFileSync(soulPath(config.id), "utf8"); } catch { /* legacy bot */ }
  return { ...config, soul };
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
  const config: BotConfig = { id, name, avatarColor: randomAvatarColor(), avatarImage: null, createdAt: now, updatedAt: now, model: input.model ?? null, thinkingLevel: input.thinkingLevel ?? null, permissionMode: input.permissionMode ?? null, skills: { ...DEFAULT_SKILLS }, extraRoots: [], enabled: true };
  mkdirSync(join(botRoot(id), "workspace"), { recursive: true });
  writeFileSync(soulPath(id), SOUL_TEMPLATE, "utf8"); writeConfig(config);
  insertBotTask({ id: `bot:${id}`, botId: id, name, directory: join(botRoot(id), "workspace"), model: config.model, thinkingLevel: config.thinkingLevel, permissionMode: config.permissionMode });
  return toDto(config);
}
export function patchBot(id: string, patch: Partial<Pick<BotConfig, "name" | "avatarColor" | "avatarImage" | "model" | "thinkingLevel" | "permissionMode" | "skills" | "extraRoots" | "enabled">> & { soul?: string }): BotDto | undefined {
  const current = parseConfig(id); if (!current) return undefined;
  const next: BotConfig = { ...current, ...patch, skills: patch.skills ?? current.skills, updatedAt: new Date().toISOString() };
  delete (next as Record<string, unknown>).soul;
  writeConfig(next);
  if (patch.soul !== undefined) writeFileSync(soulPath(id), patch.soul, "utf8");
  // Model routing is applied by the bot PATCH route through setTaskModel; do not write the logical model key into modelID.
  patchTask(`bot:${id}`, { title: next.name, thinkingLevel: next.thinkingLevel ?? undefined, permissionMode: next.permissionMode ?? undefined });
  return toDto(next);
}
export function deleteBot(id: string): boolean {
  if (!parseConfig(id)) return false;
  // Removes the 1:1 task and every room session of this bot.
  for (const task of listTasks(true, "bot")) { if (task.botId === id) deleteTask(task.id); }
  rmSync(botRoot(id), { recursive: true, force: true }); return true;
}
export function botWorkspace(id: string): string { return join(botRoot(id), "workspace"); }
export function botSoul(id: string): string { return readFileSync(soulPath(id), "utf8"); }
export function botTaskId(id: string): string { return `bot:${id}`; }
export function botAgentPrompt(id: string): string {
  const globalPath = join(process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "AGENTS.md");
  let global = ""; try { global = readFileSync(globalPath, "utf8"); } catch { /* optional */ }
  return [global && `# Global AGENTS.md\n${global}`, `# Bot SOUL.md\n${botSoul(id)}`].filter(Boolean).join("\n\n");
}
