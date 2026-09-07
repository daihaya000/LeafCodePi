/**
 * Pi skills with ON/OFF via leafcode-pi state (not folder moves).
 * Disabled names are filtered out of AgentSession through DefaultResourceLoader.skillsOverride.
 *
 * Discovery mirrors Pi's global skill root and LeafCodePi's bundled skill root:
 * - ~/.pi/agent/skills
 * - <repo>/skills (resolved via LEAFCODE_PI_SKILLS_DIR or cwd)
 *
 * `~/.agents/skills` is intentionally not read (see harness.ts, which also
 * strips any ~/.agents skills Pi loads internally).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { resolvePiAgentDir } from "@/lib/agents-md";
import { dataDir } from "@/lib/paths";
import type { BotSkillsConfig } from "@/lib/types";
import { bundledExtensionEntries } from "@/lib/extensions";

export type SkillSource = "pi" | "bundled";

export type SkillDto = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  filePath: string;
  source: SkillSource;
};

export type SkillListResult = {
  skills: SkillDto[];
  /** Primary Pi agent skills dir (for display). */
  skillsDir: string;
  /** LeafCodePi bundled skills dir, when available. */
  bundledSkillsDir: string | null;
};

type SkillsState = {
  /** Skill names that must not load into AgentSession. */
  disabled: Record<string, true>;
};

export class SkillsError extends Error {
  constructor(
    readonly code: "invalid-name" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

export function skillsErrorStatus(error: unknown): number {
  if (error instanceof SkillsError) {
    return error.code === "invalid-name" ? 400 : 404;
  }
  return 500;
}

export function skillsStatePath(dir = dataDir()): string {
  return join(dir, "skills-state.json");
}

export function skillsDir(agentDir = resolvePiAgentDir()): string {
  return join(agentDir, "skills");
}

/** Repository skills shipped with LeafCodePi. */
export function bundledSkillsDir(): string | null {
  const override = process.env.LEAFCODE_PI_SKILLS_DIR?.trim();
  const candidates = override
    ? [override]
    : [join(process.cwd(), "skills"), join(process.cwd(), "..", "skills")];
  for (const candidate of candidates) {
    const absolute = resolve(process.cwd(), candidate);
    try {
      if (statSync(absolute).isDirectory()) return absolute;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Bundled extensions ship their procedures alongside index.ts, not in the global agent dir. */
export function bundledSkillPaths(root = bundledSkillsDir()): string[] {
  const paths = root ? [root] : [];
  for (const entry of bundledExtensionEntries()) {
    const path = resolve(dirname(entry.filePath), "skills");
    if (existsSync(path) && statSync(path).isDirectory()) paths.push(path);
  }
  return [...new Set(paths)];
}

function emptyState(): SkillsState {
  return { disabled: {} };
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

export function readSkillsState(path = skillsStatePath()): SkillsState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SkillsState>;
    const disabled: Record<string, true> = {};
    if (parsed.disabled && typeof parsed.disabled === "object" && !Array.isArray(parsed.disabled)) {
      for (const [key, value] of Object.entries(parsed.disabled)) {
        if (value === true && typeof key === "string" && key.trim()) disabled[key] = true;
      }
    }
    return { disabled };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[skills] failed to read state", error);
    }
    return emptyState();
  }
}

export function writeSkillsState(state: SkillsState, path = skillsStatePath()): void {
  atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function isSkillDisabled(name: string, state = readSkillsState()): boolean {
  return state.disabled[name] === true;
}

/** Filter for DefaultResourceLoader.skillsOverride. */
export function filterSkillsByState<T extends { name: string }>(
  skills: readonly T[],
  state = readSkillsState(),
): T[] {
  if (Object.keys(state.disabled).length === 0) return [...skills];
  return skills.filter((skill) => state.disabled[skill.name] !== true);
}

/** Apply a Bot's per-session inherit/include/exclude allowlist. */
export function filterSkillsForBot<T extends { name: string }>(
  skills: readonly T[],
  config: BotSkillsConfig,
): T[] {
  if (config.mode === "include") {
    const allowed = new Set(config.include);
    return skills.filter((skill) => allowed.has(skill.name));
  }
  if (config.mode === "exclude") {
    const excluded = new Set(config.exclude);
    return skills.filter((skill) => !excluded.has(skill.name));
  }
  return [...skills];
}

const MAX_PROMPT_DESCRIPTION_CHARS = 200;

/** Keep skill discovery useful without injecting long trigger inventories. */
export function compactSkillsForPrompt<T extends { description: string }>(skills: readonly T[]): T[] {
  return skills.map((skill) => {
    const normalized = skill.description.replace(/\s+/g, " ").trim();
    const characters = [...normalized];
    if (characters.length <= MAX_PROMPT_DESCRIPTION_CHARS) {
      return normalized === skill.description ? skill : { ...skill, description: normalized };
    }
    const head = characters.slice(0, MAX_PROMPT_DESCRIPTION_CHARS - 1).join("");
    const wordBreak = head.lastIndexOf(" ");
    const description = `${(wordBreak >= 150 ? head.slice(0, wordBreak) : head).trimEnd()}…`;
    return { ...skill, description };
  });
}

function loadFromDir(dir: string, source: SkillSource): Array<Skill & { source: SkillSource }> {
  if (!existsSync(dir)) return [];
  return loadSkillsFromDir({ dir, source }).skills.map((skill) => ({ ...skill, source }));
}

export type ListSkillsOptions = {
  /** Override the Pi agent skills dir (tests). */
  skillsDir?: string;
  /** Override all bundled discovery with one skills dir; null disables it. */
  bundledDir?: string | null;
};

/**
 * List discoverable skills from Pi and LeafCodePi's bundled roots.
 * Toggle keys by skill name. Pi skills win same-name collisions because the
 * resource loader appends additional bundled paths after its normal roots.
 */
export function listSkills(
  agentDir = resolvePiAgentDir(),
  options?: ListSkillsOptions,
): SkillListResult {
  const piDir = options?.skillsDir ?? skillsDir(agentDir);
  const bundledDir = options?.bundledDir === null
    ? null
    : options?.bundledDir ?? bundledSkillsDir();
  const state = readSkillsState();
  const byName = new Map<string, Skill & { source: SkillSource }>();
  for (const skill of loadFromDir(piDir, "pi")) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  const bundledPaths = options?.bundledDir !== undefined
    ? (bundledDir ? [bundledDir] : [])
    : bundledSkillPaths(bundledDir);
  for (const path of bundledPaths) {
    for (const skill of loadFromDir(path, "bundled")) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  const skills = [...byName.values()]
    .map(
      (skill): SkillDto => ({
        id: skill.name,
        name: skill.name,
        description: skill.description || undefined,
        enabled: !isSkillDisabled(skill.name, state),
        filePath: skill.filePath,
        source: skill.source,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { skills, skillsDir: piDir, bundledSkillsDir: bundledDir };
}

export function setSkillEnabled(
  name: string,
  enabled: boolean,
  agentDir = resolvePiAgentDir(),
  options?: ListSkillsOptions,
): SkillListResult {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new SkillsError("invalid-name", "名前が不正です");
  }
  const listed = listSkills(agentDir, options);
  if (!listed.skills.some((skill) => skill.name === trimmed)) {
    throw new SkillsError("not-found", "スキルが見つかりません");
  }
  const state = readSkillsState();
  if (enabled) delete state.disabled[trimmed];
  else state.disabled[trimmed] = true;
  writeSkillsState(state);
  return listSkills(agentDir, options);
}
