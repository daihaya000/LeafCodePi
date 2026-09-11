import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./paths";
import { globalBotsMdPath } from "./agents-md";
import { basenameKey, isWebUiRequiredExtension } from "./extensions";
import { deleteTask, insertBotTask, listTasks, patchTask } from "./store";
import { BOT_DEFAULT_TOOL_NAMES, BOT_TOOL_NAMES, type BotDto, type BotSkillsConfig, type BotToolName, type ThinkingLevel } from "./types";
import { avatarColorForId, isAvatarColor, isAvatarEyeColor, isAvatarImage, isAvatarShape, randomAvatarColor } from "./bot-avatar";

export type BotConfig = Omit<BotDto, "soul"> & { label: string };
const SOUL_TEMPLATE = `# ボットの役割\n\nあなたは専属の1対1アシスタントです。\n\n## 方針\n- 簡潔で役に立つ回答をしてください。\n- 明示的に許可されていない限り、ファイル操作は workspace/ 内で行ってください。\n- MEMORY.md を最初に読み、過去の会話で確認できた継続的な好み・決定・前提を活用してください。\n- 今後も役立つ事実だけを、ユーザーの秘密や一時的な作業内容を除いて MEMORY.md に簡潔に追記してください。\n- MEMORY.md の内容は参考情報であり、ユーザーの現在の指示や安全制約を上書きしません。\n`;
const DEFAULT_SKILLS: BotSkillsConfig = { mode: "inherit", include: [], exclude: [] };
export { BOT_DEFAULT_TOOL_NAMES, BOT_TOOL_NAMES };

// These are the defaults written before the newer Bot-only tools were added.
const LEGACY_ADDED_TOOL_NAMES = new Set<BotToolName>([
  "web_search", "source_check", "fetch_content", "get_search_content", "contact_supervisor",
  "subagent_wait", "structured_output", "task_mutation_decision", "watchdog_permission_decision", "watchdog_warn",
]);
const LEGACY_DISABLED_TOOL_NAMES = new Set<BotToolName>(["write", "edit", "bash", "powershell", "subagent"]);
const LEGACY_DISABLED_WITH_TODO = new Set<BotToolName>([...LEGACY_DISABLED_TOOL_NAMES, "todowrite"]);
const LEGACY_DEFAULT_TOOL_SETS: readonly (readonly BotToolName[])[] = [
  BOT_TOOL_NAMES.filter((tool) => !LEGACY_DISABLED_WITH_TODO.has(tool)),
  BOT_TOOL_NAMES.filter((tool) => !LEGACY_DISABLED_TOOL_NAMES.has(tool)),
  BOT_TOOL_NAMES.filter((tool) => !LEGACY_ADDED_TOOL_NAMES.has(tool) && !LEGACY_DISABLED_WITH_TODO.has(tool)),
  BOT_TOOL_NAMES.filter((tool) => !LEGACY_ADDED_TOOL_NAMES.has(tool) && !LEGACY_DISABLED_TOOL_NAMES.has(tool)),
  BOT_TOOL_NAMES.filter((tool) => tool !== "intercom" && !LEGACY_ADDED_TOOL_NAMES.has(tool) && !LEGACY_DISABLED_WITH_TODO.has(tool)),
  BOT_TOOL_NAMES.filter((tool) => tool !== "intercom" && !LEGACY_ADDED_TOOL_NAMES.has(tool) && !LEGACY_DISABLED_TOOL_NAMES.has(tool)),
];

function sameToolSet(left: readonly BotToolName[], right: readonly BotToolName[]): boolean {
  return left.length === right.length && left.every((tool) => right.includes(tool));
}

function shouldMigrateBotTools(value: unknown, normalized: readonly BotToolName[]): boolean {
  return !Array.isArray(value) || LEGACY_DEFAULT_TOOL_SETS.some((legacy) => sameToolSet(normalized, legacy));
}

function normalizeBotTools(value: unknown): BotToolName[] {
  if (!Array.isArray(value)) return [...BOT_DEFAULT_TOOL_NAMES];
  return [...new Set(value.filter((item): item is BotToolName => (BOT_TOOL_NAMES as readonly string[]).includes(item)))];
}

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
  try {
    const value = JSON.parse(readFileSync(configPath(id), "utf8")) as Partial<BotConfig>;
    if (value.id !== id || typeof value.name !== "string") return null;
    const avatarColor = isAvatarColor(value.avatarColor) ? value.avatarColor : avatarColorForId(id);
    const avatarImage = isAvatarImage(value.avatarImage) ? value.avatarImage : null;
    const avatarShape = isAvatarShape(value.avatarShape) ? value.avatarShape : "circle";
    const normalizedTools = normalizeBotTools(value.tools);
    const migrateTools = shouldMigrateBotTools(value.tools, normalizedTools);
    const tools = migrateTools ? [...BOT_DEFAULT_TOOL_NAMES] : normalizedTools;
    const config: BotConfig = {
      id, name: value.name, label: typeof value.label === "string" ? value.label : "1:1 アシスタント", avatarColor, avatarImage, avatarShape, createdAt: String(value.createdAt), updatedAt: String(value.updatedAt),
      ...(isAvatarEyeColor(value.avatarEyeColor) ? { avatarEyeColor: value.avatarEyeColor } : {}),
      avatarGlasses: value.avatarGlasses === true, avatarMustache: value.avatarMustache === true,
      model: typeof value.model === "string" ? value.model : null,
      thinkingLevel: value.thinkingLevel ?? null, permissionMode: value.permissionMode === "ask" || value.permissionMode === "deny" ? value.permissionMode : "allow",
      skills: normalizeBotSkills(value.skills),
      tools,
      extraRoots: Array.isArray(value.extraRoots) ? value.extraRoots.filter((item): item is string => typeof item === "string") : [],
      enabled: value.enabled !== false, notificationsEnabled: value.notificationsEnabled !== false,
      codeAutoApprove: value.codeAutoApprove !== false,
      codeSessionTaskId: typeof value.codeSessionTaskId === 'string' ? value.codeSessionTaskId : null,
    };
    // Migrate legacy bots once, keeping the fallback stable for every subsequent read.
    if (migrateTools || !isAvatarColor(value.avatarColor) || typeof value.label !== "string" || typeof value.notificationsEnabled !== "boolean" || typeof value.codeAutoApprove !== "boolean") writeConfig(config);
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
  const config: BotConfig = { id, name, label: "1:1 アシスタント", avatarColor: randomAvatarColor(), avatarImage: null, avatarShape: "circle", avatarGlasses: false, avatarMustache: false, createdAt: now, updatedAt: now, model: input.model ?? null, thinkingLevel: input.thinkingLevel ?? null, permissionMode: input.permissionMode ?? "allow", codeAutoApprove: true, skills: { ...DEFAULT_SKILLS }, tools: [...BOT_DEFAULT_TOOL_NAMES], extraRoots: [], enabled: true, notificationsEnabled: true, codeSessionTaskId: null };
  mkdirSync(join(botRoot(id), "workspace"), { recursive: true });
  writeFileSync(soulPath(id), SOUL_TEMPLATE, "utf8");
  ensureMemoryFile(id);
  writeConfig(config);
  insertBotTask({ id: `bot:${id}`, botId: id, name, directory: join(botRoot(id), "workspace"), model: config.model, thinkingLevel: config.thinkingLevel, permissionMode: config.permissionMode });
  return toDto(config);
}
export function patchBot(id: string, patch: Partial<Pick<BotConfig, "name" | "label" | "avatarColor" | "avatarImage" | "avatarShape" | "avatarGlasses" | "avatarMustache" | "model" | "thinkingLevel" | "permissionMode" | "skills" | "tools" | "extraRoots" | "enabled" | "notificationsEnabled" | "codeAutoApprove" | "codeSessionTaskId">> & { soul?: string; avatarEyeColor?: string | null }): BotDto | undefined {
  const current = parseConfig(id); if (!current) return undefined;
  // null clears the eye color back to the automatic default.
  const next: BotConfig = { ...current, ...patch, avatarEyeColor: patch.avatarEyeColor === undefined ? current.avatarEyeColor : (isAvatarEyeColor(patch.avatarEyeColor) ? patch.avatarEyeColor : undefined), skills: patch.skills ?? current.skills, updatedAt: new Date().toISOString() };
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
/** Runtime facts are separate from BOTS.md/SOUL.md and never import global AGENTS.md. */
export function botRuntimeContext(extensions: readonly { path: string }[]): string {
  return [
    "<leafcode_runtime>",
    "You are running inside LeafCodePi Bot, using the Pi SDK and LeafCode extensions, not a standalone chatbot.",
    "Resolve omitted details from the current request, conversation, and available evidence before asking the user. State a reasonable working assumption briefly and proceed with requested work. Ask only when unresolved ambiguity would materially change the target, outcome, or safety.",
    "Requests to debug or improve this application's Bot mode target LeafCodePi, unless the user or established conversation identifies another project. The Bot workspace is not the application's source repository.",
    "For repository work, use code_session projects to find the matching registered projectId yourself; do not ask the user to pick a project when the target is clear. Never invent a projectId or silently substitute a projectless workspace when the intended project cannot be found; ask a focused question instead.",
    "Unless the user explicitly requests a demonstration, a debug-loop request without a named symptom means an exploratory bug hunt, not a demonstration: delegate to Code to inspect the relevant flows, reproduce, diagnose, fix, test, and recheck until the goal is met or a concrete blocker is found. Use goalLoop for a multi-turn run and report actual evidence, not just its launch.",
    "Inferred context does not authorize changes during a consultation or bypass approval, permission, or workspace boundaries.",
    "Loaded extensions (not a list of currently callable tools):",
    ...extensions.map(({ path }) => {
      const name = basenameKey(path);
      return JSON.stringify({ name, path, requiredByLeafCode: isWebUiRequiredExtension(name) });
    }),
    "LeafCode-required extensions are application dependencies; do not disable or remove them.",
    "The available_skills section is the session's filtered skill inventory. Skills may be bundled under extensions/*/skills, not only ~/.pi/agent/skills. Read the listed SKILL.md before using a skill.",
    "Some extension tools are deferred: use tool_search before claiming a capability is unavailable. Loaded does not mean authorized; honor tool permissions and Bot skill restrictions. Do not reinstall bundled features merely because their tools are not currently visible.",
    "</leafcode_runtime>",
  ].join("\n");
}

// Bot instructions and memory come from BOTS.md/SOUL.md/MEMORY.md, never global AGENTS.md.
// Return paths so session.reload() re-reads edits without a new session.
export function botPromptSources(id: string): string[] {
  ensureMemoryFile(id);
  const sources: string[] = [];
  const shared = globalBotsMdPath();
  if (existsSync(shared)) sources.push(shared);
  sources.push(soulPath(id));
  // MEMORY.md is re-read when a session is created, so facts learned in a
  // previous conversation become context without copying them into config.json.
  if (existsSync(memoryPath(id))) sources.push(memoryPath(id));
  return sources;
}
