import { lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

export const SKILL_PATH_GUIDANCE = "Skill paths: the <location> in <available_skills> is authoritative. Read that exact absolute path; never reconstruct ~/.pi/agent/skills/<name>/SKILL.md. LeafCodePi bundles skills in its repository skills/ and extensions/*/skills/, independently of the task cwd. Resolve relative references against the listed SKILL.md directory. Do not copy or install bundled skills into the global directory.";

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Child processes run in arbitrary projects; resolve bundled roots from this module, not cwd. */
export function bundledSkillPaths(): string[] {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const root = resolve(process.env.LEAFCODE_PI_SKILLS_DIR?.trim() || join(repo, "skills"));
  const extensions = resolve(process.env.LEAFCODE_PI_EXTENSIONS_DIR?.trim() || join(repo, "extensions"));
  const paths = isDirectory(root) ? [root] : [];
  if (isDirectory(extensions)) {
    for (const entry of readdirSync(extensions).sort()) {
      if (entry.startsWith(".")) continue;
      const path = join(extensions, entry, "skills");
      if (isDirectory(path)) paths.push(path);
    }
  }
  return [...new Set(paths)];
}

type SkillLocation = { name: string; path: string };

function decodeXml(value: string): string {
  return value.replace(/&(lt|gt|quot|apos|amp);/g, (_, entity: string) => (
    ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[entity]!)
  ));
}

/** Use the filtered prompt inventory, including explicitly configured child skills. */
function skillLocations(prompt: string): SkillLocation[] {
  const skills: SkillLocation[] = [];
  for (const inventory of prompt.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)) {
    for (const entry of inventory[1].matchAll(/<skill>([\s\S]*?)<\/skill>/g)) {
      const name = entry[1].match(/<name>([\s\S]*?)<\/name>/)?.[1];
      const location = entry[1].match(/<location>([\s\S]*?)<\/location>/)?.[1];
      if (!name || !location) continue;
      const path = decodeXml(location.trim());
      if (isAbsolute(path) && basename(path).toLowerCase() === "skill.md") {
        skills.push({ name: decodeXml(name.trim()), path });
      }
    }
  }
  return skills;
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.replace(/^~[\\/]/, () => `${homedir()}${sep}`);
}

export function resolveSkillReadPath(input: string, cwd: string, skills: readonly SkillLocation[]): string | undefined {
  const requested = resolve(cwd, expandHome(input));
  const roots = [
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    join(homedir(), ".pi", "agent"),
  ].map((agentDir) => join(expandHome(agentDir), "skills"));
  roots.push(join(homedir(), ".agents", "skills"));
  const alias = roots.map((root) => relative(resolve(root), requested).split(sep))
    .find((parts) => parts.length === 2 && parts[0] !== ".." && parts[1].toLowerCase() === "skill.md");
  if (!alias) return undefined;
  const candidates = [...new Set(skills.filter((skill) => skill.name === alias[0]).map((skill) => skill.path))];
  if (candidates.length !== 1 || resolve(candidates[0]) === requested) return undefined;
  try {
    // Existing files, directories, symlinks and permission failures retain native read semantics.
    lstatSync(requested);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  return candidates[0];
}

export default function registerSkillPaths(pi: ExtensionAPI): (event: ToolCallEvent, ctx: ExtensionContext) => void {
  let skills: SkillLocation[] = [];
  const redirected = new Map<string, string>();
  pi.on("before_agent_start", (event) => {
    skills = skillLocations(event.systemPrompt);
    redirected.clear();
    if (skills.length && !event.systemPrompt.includes(SKILL_PATH_GUIDANCE)) {
      return { systemPrompt: `${event.systemPrompt}\n\n${SKILL_PATH_GUIDANCE}` };
    }
  });
  pi.on("tool_result", (event) => {
    const path = redirected.get(event.toolCallId);
    redirected.delete(event.toolCallId);
    if (!path) return;
    return {
      content: [
        { type: "text" as const, text: `[Skill path corrected to: ${path}. Resolve relative references against ${dirname(path)}.]` },
        ...event.content,
      ],
    };
  });
  // The permission gate calls this before inspecting paths, regardless of extension load order.
  return (event, ctx) => {
    if (event.toolName !== "read" || typeof event.input.path !== "string") return;
    const path = resolveSkillReadPath(event.input.path, ctx.cwd, skills);
    if (!path) return;
    event.input.path = path;
    redirected.set(event.toolCallId, path);
  };
}
