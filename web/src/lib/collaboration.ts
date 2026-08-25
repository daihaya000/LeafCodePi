import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_COLLABORATION_CONFIG,
  parseCollaborationConfig,
  type CollaborationConfigResult,
  type CollaborationConfigSnapshot,
} from "./collaboration-schema";

export {
  COLLABORATION_CHECK_IDS,
  COLLABORATION_LIMITS,
  DEFAULT_COLLABORATION_CONFIG,
  formatCheckArgs,
  parseCheckArgs,
  parseCollaborationConfig,
} from "./collaboration-schema";
export type {
  CollaborationCheck,
  CollaborationCheckId,
  CollaborationConfig,
  CollaborationConfigResult,
  CollaborationConfigSnapshot,
  CollaborationMode,
} from "./collaboration-schema";

// Keep this server-side contract in sync with extensions/leafcode-collaboration/contract.ts.
export const LEAFCODE_COLLABORATION_EXTENSION_NAME = "leafcode-collaboration" as const;
export const LEAFCODE_COLLABORATION_TOOL_NAMES = [
  "leafcode_collab",
  "leafcode_write",
  "leafcode_edit",
  "leafcode_check",
  "leafcode_commit",
] as const;
export const LEAFCODE_STRICT_BLOCKED_TOOL_NAMES = ["bash", "powershell", "write", "edit"] as const;

export function collaborationDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LEAFCODE_PI_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const roaming = env.APPDATA?.trim();
    if (roaming) return join(roaming, "leafcode-pi");
  }
  return join(homedir(), ".leafcode-pi");
}

export function collaborationConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(collaborationDataDir(env), "collaboration.json");
}

type ConfigCacheEntry = {
  mtimeMs: number;
  size: number;
  result: CollaborationConfigResult;
};

/**
 * Sidebar 4 秒ポーリング / TaskView・HomeView 5 秒ポーリングは設定を毎回
 * ディスクから読む。mtime/size 不変時はパース結果を再利用する。
 * （writeCollaborationConfig は実ファイルを置き換えるため変更が確実に検知される）
 */
const configCache = new Map<string, ConfigCacheEntry>();

export function readCollaborationConfig(
  env: NodeJS.ProcessEnv = process.env,
): CollaborationConfigResult {
  const path = collaborationConfigPath(env);
  try {
    const stat = statSync(path);
    const cached = configCache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.result;
    }
    const result = parseCollaborationConfig(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    configCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, result });
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: DEFAULT_COLLABORATION_CONFIG, valid: true };
    }
    return {
      config: DEFAULT_COLLABORATION_CONFIG,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function loadCollaborationConfig(
  env: NodeJS.ProcessEnv = process.env,
): CollaborationConfigSnapshot {
  const path = collaborationConfigPath(env);
  return { ...readCollaborationConfig(env), path, exists: existsSync(path) };
}

export function writeCollaborationConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): CollaborationConfigSnapshot {
  const parsed = parseCollaborationConfig(raw);
  const path = collaborationConfigPath(env);
  if (!parsed.valid) return { ...parsed, path, exists: existsSync(path) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed.config, null, 2)}\n`, "utf8");
  return { ...parsed, path, exists: true };
}
