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

export type AgentListResult = {
  agents: AgentDto[];
  /** User agents dir (for display). */
  agentsDir: string;
};

export class AgentsError extends Error {
  constructor(
    readonly code: "invalid-name" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

export function agentsErrorStatus(error: unknown): number {
  if (error instanceof AgentsError) {
    return error.code === "invalid-name" ? 400 : 404;
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
