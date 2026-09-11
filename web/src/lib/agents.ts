/**
 * pi-subagents agents with ON/OFF.
 *
 * Discovery mirrors pi-subagents:
 * - User:   ~/.pi/agent/agents（再帰検索 .md）
 * - Package: agents/ dir inside each installed pi package (e.g. pi-subagents builtins)
 *
 * ON/OFF is persisted in ~/.pi/agent/settings.json under
 * `subagents.agentOverrides.<name>` (user scope), which pi-subagents reads
 * and applies for disabled state and package agent model / thinking / tool overrides.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { resolvePiAgentDir } from "@/lib/agents-md";
import { readPiSettings } from "@/lib/extensions";
import { bundledExtensionsDir, resolvePackageDir } from "@/lib/extensions";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import { isThinkingLevel } from "@/lib/thinking-levels";
import type { ThinkingLevel } from "@/lib/types";

/**
 * `thinking: false` is pi-subagents' explicit "no thinking" marker and outranks
 * `subagents.defaultThinking`, so it must survive round-trips as a real value.
 */
export type AgentThinking = ThinkingLevel | false;

export type AgentDto = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  model?: string;
  thinking?: AgentThinking;
  filePath: string;
  source: "user" | "builtin" | "package";
  tools?: string[];
};

/** Editable fields for user agent definitions. */
export type AgentDraft = {
  name: string;
  description?: string;
  aliases?: string[];
  tools?: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: AgentThinking;
  systemPromptMode?: "replace" | "append";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  async?: boolean;
  systemPrompt: string;
};

export type AgentListResult = {
  agents: AgentDto[];
  /** User agents dir (for display). */
  agentsDir: string;
};

export class AgentsError extends Error {
  constructor(
    readonly code: "invalid-name" | "not-found" | "readonly",
    message: string,
  ) {
    super(message);
  }
}

export function agentsErrorStatus(error: unknown): number {
  if (error instanceof AgentsError) {
    return error.code === "invalid-name" ? 400 : error.code === "readonly" ? 403 : 404;
  }
  return 500;
}

export function agentsDir(agentDir = resolvePiAgentDir()): string {
  return join(agentDir, "agents");
}

type AgentOverride = { disabled?: boolean; model?: string; thinking?: AgentThinking; tools?: string[] | false | "inherit" };

type PiSettings = {
  subagents?: { agentOverrides?: Record<string, AgentOverride>; [key: string]: unknown };
  [key: string]: unknown;
};

function readSettings(agentDir: string): PiSettings {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PiSettings : {};
  } catch {
    return {};
  }
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.${Date.now()}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export type ParsedAgent = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  disabled?: unknown;
  aliases?: unknown;
  model?: unknown;
  fallbackModels?: unknown;
  thinking?: unknown;
  systemPromptMode?: unknown;
  inheritProjectContext?: unknown;
  inheritSkills?: unknown;
  async?: unknown;
};

/** Parse YAML frontmatter from a pi agent markdown file. */
export function parseAgentFile(content: string): ParsedAgent {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!match) return {};
  try {
    const data = YAML.parse(match[1]);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as ParsedAgent;
    }
  } catch {
    /* ignore */
  }
  return {};
}

/** Frontmatter keys `AgentDraft` round-trips. Everything else is preserved verbatim. */
const MANAGED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "aliases",
  "tools",
  "model",
  "fallbackModels",
  "thinking",
  "systemPromptMode",
  "inheritProjectContext",
  "inheritSkills",
  "async",
]);

function extraFrontmatterFrom(fm: ParsedAgent): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm as Record<string, unknown>)) {
    if (!MANAGED_FRONTMATTER_KEYS.has(key)) extras[key] = value;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

function readExtraFrontmatter(filePath: string): Record<string, unknown> | undefined {
  try {
    return extraFrontmatterFrom(parseAgentFile(readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

function toThinking(value: unknown): AgentThinking | undefined {
  if (value === false) return false;
  if (typeof value === "string" && isThinkingLevel(value.trim())) return value.trim() as ThinkingLevel;
  return undefined;
}

function toTools(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.split(",").map((t) => t.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((t): t is string => typeof t === "string");
  }
  return undefined;
}

type DiscoveredAgent = {
  name: string;
  description?: string;
  model?: string;
  thinking?: AgentThinking;
  tools?: string[];
  filePath: string;
};

function discoverInDir(dir: string, source: AgentDto["source"]): DiscoveredAgent[] {
  const entries: DiscoveredAgent[] = [];
  if (!existsSync(dir)) return entries;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...discoverInDir(full, source));
      continue;
    }
    if (!/\.md$/.test(entry.name)) continue;
    let content = "";
    try {
      content = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const fm = parseAgentFile(content);
    if (typeof fm.name !== "string" || !fm.name.trim()) continue;
    const description = typeof fm.description === "string" ? fm.description : undefined;
    const model = typeof fm.model === "string" && fm.model.trim() ? fm.model.trim() : undefined;
    const thinking = toThinking(fm.thinking);
    entries.push({ name: fm.name.trim(), description, model, thinking, tools: toTools(fm.tools), filePath: full });
  }
  return entries;
}

/** Find agents/ dirs inside installed pi packages (settings.json packages). */
function discoverPackageAgentDirs(agentDir: string): string[] {
  const settings = readPiSettings(agentDir);
  const dirs: string[] = [];
  for (const source of settings.packages ?? []) {
    const pkgDir = resolvePackageDir(source, agentDir);
    if (!pkgDir || !existsSync(pkgDir)) continue;
    // pi-subagents declares its conventional `agents/` folder.
    const agentsDir = join(pkgDir, "agents");
    if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) dirs.push(agentsDir);
  }
  return dirs;
}

/**
 * agents/ shipped inside the bundled leafcode-subagents fork. Listed before
 * the npm package dirs so the fork's builtin agents win same-name collisions.
 */
function bundledForkAgentsDir(): string | null {
  const root = bundledExtensionsDir();
  if (!root) return null;
  const dir = join(root, "leafcode-subagents", "agents");
  return existsSync(dir) ? dir : null;
}

export function listAgents(agentDir = resolvePiAgentDir()): AgentListResult {
  const userDir = agentsDir(agentDir);
  const settings = readSettings(agentDir);
  const overrides = settings.subagents?.agentOverrides ?? {};

  const byName = new Map<string, AgentDto>();
  const push = (source: AgentDto["source"], dir: string) => {
    for (const entry of discoverInDir(dir, source)) {
      if (entry.name === AUTO_AGENT_VALUE) continue;
      if (!byName.has(entry.name)) {
        const rawOverrideModel = overrides[entry.name]?.model;
        const overrideModel = typeof rawOverrideModel === "string" ? rawOverrideModel.trim() || undefined : undefined;
        const model = source === "user"
          ? entry.model ?? overrideModel
          : overrideModel ?? entry.model;
        const overrideThinking = overrides[entry.name]?.thinking;
        const thinking = source === "user"
          ? entry.thinking ?? overrideThinking
          : overrideThinking ?? entry.thinking;
        const rawOverrideTools = overrides[entry.name]?.tools;
        const overrideTools = Array.isArray(rawOverrideTools)
          ? rawOverrideTools.filter((tool): tool is string => typeof tool === "string")
          : rawOverrideTools === false
            ? []
            : undefined;
        const tools = source === "user"
          ? entry.tools
          : rawOverrideTools === "inherit"
            ? undefined
            : overrideTools ?? entry.tools;
        byName.set(entry.name, {
          id: entry.name,
          name: entry.name,
          description: entry.description,
          enabled: overrides[entry.name]?.disabled !== true,
          ...(model ? { model } : {}),
          ...(thinking !== undefined ? { thinking } : {}),
          filePath: entry.filePath,
          source,
          tools,
        });
      }
    }
  };

  // User agents take precedence over package/builtin same-name collisions.
  // The in-repo fork comes before installed packages so its builtins win.
  push("user", userDir);
  const forkDir = bundledForkAgentsDir();
  if (forkDir) push("package", forkDir);
  for (const pkgDir of discoverPackageAgentDirs(agentDir)) push("package", pkgDir);

  const agents = sortAgents([...byName.values()]);
  return { agents, agentsDir: userDir };
}

export function sortAgents(agents: readonly AgentDto[]): AgentDto[] {
  return [...agents].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, "en"),
  );
}

function assertListedAgent(name: string, agentDir: string): { name: string; agent: AgentDto } {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new AgentsError("invalid-name", "名前が不正です");
  }
  const listed = listAgents(agentDir);
  const agent = listed.agents.find((entry) => entry.name === trimmed);
  if (!agent) {
    throw new AgentsError("not-found", "エージェントが見つかりません");
  }
  return { name: trimmed, agent };
}

function updateAgentOverride(
  name: string,
  update: (override: AgentOverride) => void,
  agentDir: string,
): AgentListResult {
  const { name: trimmed } = assertListedAgent(name, agentDir);
  const settingsPath = join(agentDir, "settings.json");
  const settings = readSettings(agentDir);
  const subagents = settings.subagents && typeof settings.subagents === "object"
    ? { ...settings.subagents }
    : {};
  const agentOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === "object"
    ? { ...subagents.agentOverrides }
    : {};

  const current = agentOverrides[trimmed];
  const next: AgentOverride = current && typeof current === "object" && !Array.isArray(current)
    ? { ...current }
    : {};
  update(next);
  if (Object.keys(next).length > 0) agentOverrides[trimmed] = next;
  else delete agentOverrides[trimmed];

  if (Object.keys(agentOverrides).length > 0) subagents.agentOverrides = agentOverrides;
  else delete subagents.agentOverrides;

  if (Object.keys(subagents).length > 0) settings.subagents = subagents;
  else delete settings.subagents;

  atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return listAgents(agentDir);
}

export function setAgentEnabled(name: string, enabled: boolean, agentDir = resolvePiAgentDir()): AgentListResult {
  return updateAgentOverride(
    name,
    (override) => {
      if (enabled) delete override.disabled;
      else override.disabled = true;
    },
    agentDir,
  );
}

/** Set a user agent's frontmatter model or a package agent's settings override. */
export function setAgentModel(
  name: string,
  model: string | null,
  agentDir = resolvePiAgentDir(),
): AgentListResult {
  const { name: trimmed, agent } = assertListedAgent(name, agentDir);
  const nextModel = model?.trim() || null;
  if (agent.source === "user") {
    const { draft } = readUserAgent(trimmed, agentDir);
    return updateAgent({ ...draft, model: nextModel ?? undefined }, agentDir);
  }
  return updateAgentOverride(
    trimmed,
    (override) => {
      if (nextModel) override.model = nextModel;
      else delete override.model;
    },
    agentDir,
  );
}

/**
 * Set a user agent's frontmatter effort or a package agent's settings override.
 * `null` clears the setting; `false` records pi-subagents' explicit "no thinking".
 */
export function setAgentThinking(
  name: string,
  thinking: AgentThinking | null,
  agentDir = resolvePiAgentDir(),
): AgentListResult {
  const { name: trimmed, agent } = assertListedAgent(name, agentDir);
  if (agent.source === "user") {
    const { draft } = readUserAgent(trimmed, agentDir);
    return updateAgent({ ...draft, thinking: thinking ?? undefined }, agentDir);
  }
  return updateAgentOverride(
    trimmed,
    (override) => {
      if (thinking === null) delete override.thinking;
      else override.thinking = thinking;
    },
    agentDir,
  );
}

/** Set an agent's explicit tool allowlist (frontmatter for user agents, override for packages). */
export function setAgentTools(
  name: string,
  tools: readonly string[],
  agentDir = resolvePiAgentDir(),
): AgentListResult {
  const { name: trimmed, agent } = assertListedAgent(name, agentDir);
  const normalized = [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))];
  if (agent.source === "user") {
    const { draft } = readUserAgent(trimmed, agentDir);
    return updateAgent({ ...draft, tools: normalized }, agentDir);
  }
  return updateAgentOverride(
    trimmed,
    (override) => {
      override.tools = normalized;
    },
    agentDir,
  );
}

function userAgentPath(agentDir: string, name: string): string {
  return join(agentsDir(agentDir), `${name}.md`);
}

function assertValidName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === AUTO_AGENT_VALUE) throw new AgentsError("invalid-name", "予約された名前です");
  if (!trimmed || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new AgentsError("invalid-name", "名前は英数字・._- のみ使用できます");
  }
  if (trimmed.includes("..")) throw new AgentsError("invalid-name", "名前が不正です");
  return trimmed;
}

function assertEditable(agentDir: string, name: string): string {
  const listed = listAgents(agentDir);
  const agent = listed.agents.find((a) => a.name === name);
  if (!agent) throw new AgentsError("not-found", "エージェントが見つかりません");
  if (agent.source !== "user") {
    throw new AgentsError("readonly", "ビルトイン・パッケージエージェントは編集できません");
  }
  return agent.filePath;
}

function joinCsv(values: string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined;
  return values.join(", ");
}

/** Build markdown file with YAML frontmatter for a user agent. */
export function serializeAgent(
  draft: AgentDraft,
  extraFrontmatter?: Readonly<Record<string, unknown>>,
): string {
  const frontmatter: Record<string, unknown> = { name: draft.name };
  if (draft.description) frontmatter.description = draft.description;
  const aliases = joinCsv(draft.aliases);
  if (aliases) frontmatter.aliases = aliases;
  if (draft.tools !== undefined) frontmatter.tools = draft.tools.length > 0 ? draft.tools.join(", ") : "";
  if (draft.model) frontmatter.model = draft.model;
  const fallback = joinCsv(draft.fallbackModels);
  if (fallback) frontmatter.fallbackModels = fallback;
  if (draft.thinking === false) frontmatter.thinking = false;
  else if (draft.thinking) frontmatter.thinking = draft.thinking;
  if (draft.systemPromptMode) frontmatter.systemPromptMode = draft.systemPromptMode;
  if (draft.inheritProjectContext !== undefined) frontmatter.inheritProjectContext = draft.inheritProjectContext;
  if (draft.inheritSkills !== undefined) frontmatter.inheritSkills = draft.inheritSkills;
  if (draft.async !== undefined) frontmatter.async = draft.async;
  // Unmanaged keys are server-owned and never overwrite a managed value.
  for (const [key, value] of Object.entries(extraFrontmatter ?? {})) {
    if (!(key in frontmatter)) frontmatter[key] = value;
  }
  const body = draft.systemPrompt?.trim() ? `\n${draft.systemPrompt.trim()}\n` : "";
  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${body}`;
}

/** Read a user agent definition into an editable draft. */
export function readUserAgent(name: string, agentDir = resolvePiAgentDir()): { draft: AgentDraft; filePath: string } {
  const filePath = assertEditable(agentDir, name);
  const content = readFileSync(filePath, "utf8");
  const fm = parseAgentFile(content);
  const match = /^---\s*\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(content);
  const systemPrompt = match?.[1]?.trim() ?? "";
  return {
    filePath,
    draft: {
      name,
      description: typeof fm.description === "string" ? fm.description : undefined,
      aliases: fromCsv(fm.aliases),
      tools: toTools(fm.tools),
      model: typeof fm.model === "string" ? fm.model : undefined,
      fallbackModels: fromCsv(fm.fallbackModels),
      thinking: toThinking(fm.thinking),
      systemPromptMode: fm.systemPromptMode === "append" ? "append" : fm.systemPromptMode === "replace" ? "replace" : undefined,
      inheritProjectContext: typeof fm.inheritProjectContext === "boolean" ? fm.inheritProjectContext : undefined,
      inheritSkills: typeof fm.inheritSkills === "boolean" ? fm.inheritSkills : undefined,
      async: typeof fm.async === "boolean" ? fm.async : undefined,
      systemPrompt,
    },
  };
}

function fromCsv(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const list = value.split(",").map((v) => v.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (Array.isArray(value)) {
    const list = value.filter((v): v is string => typeof v === "string");
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

/** Create a new user agent. Rejects names that already exist. */
export function createAgent(draft: AgentDraft, agentDir = resolvePiAgentDir()): AgentListResult {
  const name = assertValidName(draft.name);
  const existing = listAgents(agentDir);
  if (existing.agents.some((a) => a.name === name)) {
    throw new AgentsError("invalid-name", "同名のエージェントが既に存在します");
  }
  mkdirSync(agentsDir(agentDir), { recursive: true });
  atomicWrite(userAgentPath(agentDir, name), serializeAgent({ ...draft, name }));
  return listAgents(agentDir);
}

/** Update a user agent. Frontmatter the editor does not manage is preserved server-side. */
export function updateAgent(draft: AgentDraft, agentDir = resolvePiAgentDir()): AgentListResult {
  const name = assertValidName(draft.name);
  const filePath = assertEditable(agentDir, name);
  atomicWrite(filePath, serializeAgent({ ...draft, name }, readExtraFrontmatter(filePath)));
  return listAgents(agentDir);
}

/** Delete a user agent. */
export function deleteAgent(name: string, agentDir = resolvePiAgentDir()): AgentListResult {
  const filePath = assertEditable(agentDir, name.trim());
  rmSync(filePath, { force: true });
  return listAgents(agentDir);
}

/** An agent definition resolved for running it as the main session persona. */
export type LoadedAgentDefinition = {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  thinking?: string | false;
  /** pi-subagents semantics: replace (default) swaps the base prompt, append adds to it. */
  systemPromptMode: "replace" | "append";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  /** Markdown body — the agent's own instructions. */
  systemPrompt: string;
};

function defaultSystemPromptMode(name: string): "replace" | "append" {
  // pi-subagents: only the built-in delegate agent appends by default.
  return name === "delegate" ? "append" : "replace";
}

/**
 * Load an enabled agent definition (user / package / builtin) by name.
 * Defaults mirror pi-subagents' frontmatter handling.
 */
export function loadAgentDefinition(
  name: string,
  agentDir = resolvePiAgentDir(),
): LoadedAgentDefinition | undefined {
  const trimmed = name.trim();
  if (!trimmed || trimmed === AUTO_AGENT_VALUE) return undefined;
  const dto = listAgents(agentDir).agents.find(
    (agent) => agent.name === trimmed && agent.enabled,
  );
  if (!dto) return undefined;
  let content = "";
  try {
    content = readFileSync(dto.filePath, "utf8");
  } catch {
    return undefined;
  }
  const fm = parseAgentFile(content);
  const match = /^---\s*\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(content);
  return {
    name: dto.name,
    ...(typeof fm.description === "string" && fm.description.trim()
      ? { description: fm.description.trim() }
      : {}),
    tools: dto.tools,
    model: typeof fm.model === "string" && fm.model.trim() ? fm.model.trim() : undefined,
    thinking: toThinking(fm.thinking),
    systemPromptMode:
      fm.systemPromptMode === "append"
        ? "append"
        : fm.systemPromptMode === "replace"
          ? "replace"
          : defaultSystemPromptMode(dto.name),
    inheritProjectContext:
      typeof fm.inheritProjectContext === "boolean"
        ? fm.inheritProjectContext
        : dto.name === "delegate",
    inheritSkills: typeof fm.inheritSkills === "boolean" ? fm.inheritSkills : true,
    systemPrompt: (match?.[1] ?? "").trim(),
  };
}

/**
 * Resource-loader options that make the selected agent talk as the main
 * session (mirrors how pi CLI applies --system-prompt/--append-system-prompt,
 * --no-context-files and --no-skills for subagent child sessions).
 */
export function buildAgentResourceOptions(definition: LoadedAgentDefinition): {
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  noContextFiles?: boolean;
  noSkills?: boolean;
  tools?: string[];
} {
  // An empty body means "no prompt override", like pi-subagents does.
  const prompt =
    definition.systemPromptMode === "replace"
      ? definition.systemPrompt || undefined
      : undefined;
  const append =
    definition.systemPromptMode === "append" && definition.systemPrompt
      ? [definition.systemPrompt]
      : undefined;
  return {
    ...(prompt ? { systemPrompt: prompt } : {}),
    ...(append ? { appendSystemPrompt: append } : {}),
    ...(definition.inheritProjectContext ? {} : { noContextFiles: true }),
    ...(definition.inheritSkills ? {} : { noSkills: true }),
    ...(definition.tools !== undefined ? { tools: definition.tools } : {}),
  };
}
