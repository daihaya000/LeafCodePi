import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
export const LEAFCODE_STRICT_BLOCKED_TOOL_NAMES = ["bash", "write", "edit"] as const;

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

export function readCollaborationConfig(
  env: NodeJS.ProcessEnv = process.env,
): CollaborationConfigResult {
  try {
    return parseCollaborationConfig(JSON.parse(readFileSync(collaborationConfigPath(env), "utf8")) as unknown);
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
