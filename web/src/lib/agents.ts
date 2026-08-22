/**
 * pi-subagents agents with ON/OFF.
 *
 * Discovery mirrors pi-subagents:
 * - User:   ~/.pi/agent/agents（再帰検索 .md）
 * - Package: agents/ dir inside each installed pi package (e.g. pi-subagents builtins)
 *
 * ON/OFF is persisted in ~/.pi/agent/settings.json under
 * `subagents.agentOverrides.<name>.disabled` (user scope), which pi-subagents
 * reads and applies.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { resolvePiAgentDir } from "@/lib/agents-md";
import { readPiSettings } from "@/lib/extensions";
import { resolvePackageDir } from "@/lib/extensions";

export type AgentDto = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
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
  thinking?: string;
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

function readSettings(agentDir: string): { subagents?: { agentOverrides?: Record<string, { disabled?: boolean }> } } {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
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

function toTools(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.split(",").map((t) => t.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((t): t is string => typeof t === "string");
  }
  return undefined;
}

function discoverInDir(dir: string, source: AgentDto["source"]): Array<{ name: string; description?: string; tools?: string[]; filePath: string }> {
  const entries: Array<{ name: string; description?: string; tools?: string[]; filePath: string }> = [];
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
    entries.push({ name: fm.name.trim(), description, tools: toTools(fm.tools), filePath: full });
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

export function listAgents(agentDir = resolvePiAgentDir()): AgentListResult {
  const userDir = agentsDir(agentDir);
  const settings = readSettings(agentDir);
  const overrides = settings.subagents?.agentOverrides ?? {};

  const byName = new Map<string, AgentDto>();
  const push = (source: AgentDto["source"], dir: string) => {
    for (const entry of discoverInDir(dir, source)) {
      if (!byName.has(entry.name)) {
        byName.set(entry.name, {
          id: entry.name,
          name: entry.name,
          description: entry.description,
          enabled: overrides[entry.name]?.disabled !== true,
          filePath: entry.filePath,
          source,
          tools: entry.tools,
        });
      }
    }
  };

  // User agents take precedence over package/builtin same-name collisions.
  push("user", userDir);
  for (const pkgDir of discoverPackageAgentDirs(agentDir)) push("package", pkgDir);

  const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { agents, agentsDir: userDir };
}

export function setAgentEnabled(name: string, enabled: boolean, agentDir = resolvePiAgentDir()): AgentListResult {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new AgentsError("invalid-name", "名前が不正です");
  }
  const listed = listAgents(agentDir);
  if (!listed.agents.some((agent) => agent.name === trimmed)) {
    throw new AgentsError("not-found", "エージェントが見つかりません");
  }

  const settingsPath = join(agentDir, "settings.json");
  const settings = readSettings(agentDir);
  const subagents = settings.subagents && typeof settings.subagents === "object"
    ? { ...settings.subagents }
    : {};
  const agentOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === "object"
    ? { ...subagents.agentOverrides }
    : {};

  if (enabled) {
    const current = agentOverrides[trimmed];
    if (current && typeof current === "object") {
      const next = { ...current };
      delete next.disabled;
      if (Object.keys(next).length > 0) agentOverrides[trimmed] = next;
      else delete agentOverrides[trimmed];
    } else {
      delete agentOverrides[trimmed];
    }
  } else {
    agentOverrides[trimmed] = { ...(agentOverrides[trimmed] ?? {}), disabled: true };
  }

  if (Object.keys(agentOverrides).length > 0) subagents.agentOverrides = agentOverrides;
  else delete subagents.agentOverrides;

  if (Object.keys(subagents).length > 0) settings.subagents = subagents;
  else delete settings.subagents;

  atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return listAgents(agentDir);
}

function userAgentPath(agentDir: string, name: string): string {
  return join(agentsDir(agentDir), `${name}.md`);
}

function assertValidName(name: string): string {
  const trimmed = name.trim();
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
export function serializeAgent(draft: AgentDraft): string {
  const frontmatter: Record<string, unknown> = { name: draft.name };
  if (draft.description) frontmatter.description = draft.description;
  const aliases = joinCsv(draft.aliases);
  if (aliases) frontmatter.aliases = aliases;
  const tools = joinCsv(draft.tools);
  if (tools) frontmatter.tools = tools;
  if (draft.model) frontmatter.model = draft.model;
  const fallback = joinCsv(draft.fallbackModels);
  if (fallback) frontmatter.fallbackModels = fallback;
  if (draft.thinking) frontmatter.thinking = draft.thinking;
  if (draft.systemPromptMode) frontmatter.systemPromptMode = draft.systemPromptMode;
  if (draft.inheritProjectContext !== undefined) frontmatter.inheritProjectContext = draft.inheritProjectContext;
  if (draft.inheritSkills !== undefined) frontmatter.inheritSkills = draft.inheritSkills;
  if (draft.async !== undefined) frontmatter.async = draft.async;
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
      thinking: typeof fm.thinking === "string" ? fm.thinking : undefined,
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

/** Update a user agent. */
export function updateAgent(draft: AgentDraft, agentDir = resolvePiAgentDir()): AgentListResult {
  const name = assertValidName(draft.name);
  const filePath = assertEditable(agentDir, name);
  atomicWrite(filePath, serializeAgent({ ...draft, name }));
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
  thinking?: string;
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
  if (!trimmed) return undefined;
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
    tools: toTools(fm.tools),
    model: typeof fm.model === "string" && fm.model.trim() ? fm.model.trim() : undefined,
    thinking: typeof fm.thinking === "string" && fm.thinking.trim() ? fm.thinking.trim() : undefined,
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
    inheritSkills: typeof fm.inheritSkills === "boolean" ? fm.inheritSkills : false,
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
    ...(definition.tools && definition.tools.length > 0 ? { tools: definition.tools } : {}),
  };
}
