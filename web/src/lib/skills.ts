/**
 * Global Pi skills with ON/OFF via leafcode-pi state (not folder moves).
 * Disabled names are filtered out of AgentSession through DefaultResourceLoader.skillsOverride.
 *
 * Discovery mirrors Pi's global skill root:
 * - ~/.pi/agent/skills
 *
 * `~/.agents/skills` is intentionally not read (see harness.ts, which also
 * strips any ~/.agents skills Pi loads internally).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { resolvePiAgentDir } from "@/lib/agents-md";
import { dataDir } from "@/lib/paths";

export type SkillSource = "pi";

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

function loadFromDir(dir: string, source: SkillSource): Array<Skill & { source: SkillSource }> {
  if (!existsSync(dir)) return [];
  return loadSkillsFromDir({ dir, source }).skills.map((skill) => ({ ...skill, source }));
}

/**
 * List globally discoverable skills (Pi agent dir only).
 * Toggle keys by skill name.
 */
export function listSkills(
  agentDir = resolvePiAgentDir(),
): SkillListResult {
  const piDir = skillsDir(agentDir);
  const state = readSkillsState();
  const byName = new Map<string, Skill & { source: SkillSource }>();
  for (const skill of loadFromDir(piDir, "pi")) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
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
  return { skills, skillsDir: piDir };
}

export function setSkillEnabled(
  name: string,
  enabled: boolean,
  agentDir = resolvePiAgentDir(),
): SkillListResult {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new SkillsError("invalid-name", "名前が不正です");
  }
  const listed = listSkills(agentDir);
  if (!listed.skills.some((skill) => skill.name === trimmed)) {
    throw new SkillsError("not-found", "スキルが見つかりません");
  }
  const state = readSkillsState();
  if (enabled) delete state.disabled[trimmed];
  else state.disabled[trimmed] = true;
  writeSkillsState(state);
  return listSkills(agentDir);
}
