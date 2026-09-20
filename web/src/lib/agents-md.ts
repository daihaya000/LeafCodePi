import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const MAX_AGENTS_MD_BYTES = 2 * 1024 * 1024;
export const AGENTS_MD_FILENAME = "AGENTS.md";
/** Global agent personality/tone. Code sessions read it; bots use their own SOUL.md. */
export const SOUL_MD_FILENAME = "SOUL.md";
/** Global user profile. Code sessions read it. */
export const USER_MD_FILENAME = "USER.md";
/** Common instructions for bot mode. Bots never read AGENTS.md. */
export const BOTS_MD_FILENAME = "BOTS.md";
/** Optional Code reference for tool usage. Loaded on demand, never into the base prompt. */
export const TOOLS_MD_FILENAME = "TOOLS.md";
/** Optional Code reference for UI design. Loaded on demand, never into the base prompt. */
export const DESIGN_MD_FILENAME = "DESIGN.md";

export type AgentsMdDto = {
  path: string;
  exists: boolean;
  content: string;
};

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export type AgentsMdEnv = { [key: string]: string | undefined };

/** Pi's agent dir (`~/.pi/agent` or `PI_CODING_AGENT_DIR`). */
export function resolvePiAgentDir(env: AgentsMdEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return resolve(expandTilde(fromEnv));
  return join(homedir(), ".pi", "agent");
}

export function globalAgentsMdPath(env: AgentsMdEnv = process.env): string {
  return join(resolvePiAgentDir(env), AGENTS_MD_FILENAME);
}

export function globalBotsMdPath(env: AgentsMdEnv = process.env): string {
  return join(resolvePiAgentDir(env), BOTS_MD_FILENAME);
}

export function globalSoulMdPath(env: AgentsMdEnv = process.env): string {
  return join(resolvePiAgentDir(env), SOUL_MD_FILENAME);
}

export function globalUserMdPath(env: AgentsMdEnv = process.env): string {
  return join(resolvePiAgentDir(env), USER_MD_FILENAME);
}

export function globalToolsMdPath(env: AgentsMdEnv = process.env): string {
  return join(resolvePiAgentDir(env), TOOLS_MD_FILENAME);
}

export function globalDesignMdPath(env: AgentsMdEnv = process.env): string {
  return join(resolvePiAgentDir(env), DESIGN_MD_FILENAME);
}

function assertUtf8Size(filePath: string, content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_AGENTS_MD_BYTES) {
    throw Object.assign(new Error(`${basename(filePath)}は2MB以内で指定してください`), { status: 413 });
  }
}

export function readAgentsMdFile(filePath: string): AgentsMdDto {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return { path: resolved, exists: false, content: "" };
  }
  const name = basename(resolved);
  if (lstatSync(resolved).isSymbolicLink()) {
    throw Object.assign(new Error(`${name}はシンボリックリンクのため読み込めません`), {
      status: 400,
    });
  }
  const real = realpathSync.native(resolved);
  if (!statSync(real).isFile()) {
    throw Object.assign(new Error(`${name}を安全に読み込めません`), { status: 400 });
  }
  const size = statSync(real).size;
  if (size > MAX_AGENTS_MD_BYTES) {
    throw Object.assign(new Error(`${name}は2MBを超えているため編集できません`), { status: 413 });
  }
  return { path: real, exists: true, content: readFileSync(real, "utf8") };
}

export function writeAgentsMdFile(filePath: string, content: string): AgentsMdDto {
  assertUtf8Size(filePath, content);
  const target = resolve(filePath);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw Object.assign(new Error(`${basename(target)}はシンボリックリンクのため編集できません`), {
      status: 400,
    });
  }
  writeFileSync(target, content, "utf8");
  return { path: target, exists: true, content };
}

export function readGlobalAgentsMd(env: AgentsMdEnv = process.env): AgentsMdDto {
  return readAgentsMdFile(globalAgentsMdPath(env));
}

export function writeGlobalAgentsMd(content: string, env: AgentsMdEnv = process.env): AgentsMdDto {
  return writeAgentsMdFile(globalAgentsMdPath(env), content);
}

export function readGlobalBotsMd(env: AgentsMdEnv = process.env): AgentsMdDto {
  return readAgentsMdFile(globalBotsMdPath(env));
}

export function writeGlobalBotsMd(content: string, env: AgentsMdEnv = process.env): AgentsMdDto {
  return writeAgentsMdFile(globalBotsMdPath(env), content);
}

export function readGlobalSoulMd(env: AgentsMdEnv = process.env): AgentsMdDto {
  return readAgentsMdFile(globalSoulMdPath(env));
}

export function writeGlobalSoulMd(content: string, env: AgentsMdEnv = process.env): AgentsMdDto {
  return writeAgentsMdFile(globalSoulMdPath(env), content);
}

export function readGlobalUserMd(env: AgentsMdEnv = process.env): AgentsMdDto {
  return readAgentsMdFile(globalUserMdPath(env));
}

export function writeGlobalUserMd(content: string, env: AgentsMdEnv = process.env): AgentsMdDto {
  return writeAgentsMdFile(globalUserMdPath(env), content);
}

export function readGlobalToolsMd(env: AgentsMdEnv = process.env): AgentsMdDto {
  return readAgentsMdFile(globalToolsMdPath(env));
}

export function writeGlobalToolsMd(content: string, env: AgentsMdEnv = process.env): AgentsMdDto {
  return writeAgentsMdFile(globalToolsMdPath(env), content);
}

export function readGlobalDesignMd(env: AgentsMdEnv = process.env): AgentsMdDto {
  return readAgentsMdFile(globalDesignMdPath(env));
}

export function writeGlobalDesignMd(content: string, env: AgentsMdEnv = process.env): AgentsMdDto {
  return writeAgentsMdFile(globalDesignMdPath(env), content);
}

/**
 * Code session prompt sources (paths, re-read on reload).
 * Pi loads AGENTS.md natively; SOUL.md/USER.md are appended when present.
 */
export function codePromptSources(agentDir: string): string[] {
  const sources: string[] = [];
  const soul = join(agentDir, SOUL_MD_FILENAME);
  const user = join(agentDir, USER_MD_FILENAME);
  if (existsSync(soul)) sources.push(soul);
  if (existsSync(user)) sources.push(user);
  return sources;
}

/**
 * Small catalog for optional Code references. The files themselves stay out of
 * the base prompt; the model reads one only when the task needs it.
 */
export function codeOnDemandPrompt(agentDir: string): string {
  const pathForPrompt = (fileName: string) => JSON.stringify(join(agentDir, fileName).replaceAll("\\", "/"));
  return [
    "<leafcode_on_demand_context>",
    "Optional reference files are not loaded automatically. Read one with the read tool only when the task needs it:",
    `- TOOLS.md (tool usage): ${pathForPrompt(TOOLS_MD_FILENAME)}`,
    `- DESIGN.md (UI design): ${pathForPrompt(DESIGN_MD_FILENAME)}`,
    "Follow the relevant file after reading it; do not spend context loading unrelated files.",
    "</leafcode_on_demand_context>",
  ].join("\n");
}

export function errorStatus(error: unknown, fallback = 500): number {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600) {
      return status;
    }
  }
  return fallback;
}
