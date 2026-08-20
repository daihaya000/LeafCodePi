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
import { dirname, join, resolve } from "node:path";

export const MAX_AGENTS_MD_BYTES = 2 * 1024 * 1024;
export const AGENTS_MD_FILENAME = "AGENTS.md";

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

function assertUtf8Size(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_AGENTS_MD_BYTES) {
    throw Object.assign(new Error("AGENTS.mdは2MB以内で指定してください"), { status: 413 });
  }
}

export function readAgentsMdFile(filePath: string): AgentsMdDto {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return { path: resolved, exists: false, content: "" };
  }
  if (lstatSync(resolved).isSymbolicLink()) {
    throw Object.assign(new Error("AGENTS.mdはシンボリックリンクのため読み込めません"), {
      status: 400,
    });
  }
  const real = realpathSync.native(resolved);
  if (!statSync(real).isFile()) {
    throw Object.assign(new Error("AGENTS.mdを安全に読み込めません"), { status: 400 });
  }
  const size = statSync(real).size;
  if (size > MAX_AGENTS_MD_BYTES) {
    throw Object.assign(new Error("AGENTS.mdは2MBを超えているため編集できません"), { status: 413 });
  }
  return { path: real, exists: true, content: readFileSync(real, "utf8") };
}

export function writeAgentsMdFile(filePath: string, content: string): AgentsMdDto {
  assertUtf8Size(content);
  const target = resolve(filePath);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw Object.assign(new Error("AGENTS.mdはシンボリックリンクのため編集できません"), {
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

export function errorStatus(error: unknown, fallback = 500): number {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600) {
      return status;
    }
  }
  return fallback;
}
