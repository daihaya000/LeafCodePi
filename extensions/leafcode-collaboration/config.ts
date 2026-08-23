import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LeafCodeCollaborationMode } from "./contract.ts";

export type CollaborationConfig = {
  mode: LeafCodeCollaborationMode;
};

export type CollaborationConfigResult = {
  config: CollaborationConfig;
  valid: boolean;
  error?: string;
};

const DEFAULT_CONFIG: CollaborationConfig = { mode: "strict" };

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
    const raw = JSON.parse(readFileSync(collaborationConfigPath(env), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { config: DEFAULT_CONFIG, valid: false, error: "config must be an object" };
    }
    const mode = (raw as { mode?: unknown }).mode;
    if (mode === undefined) {
      return { config: DEFAULT_CONFIG, valid: false, error: "config.mode is required" };
    }
    if (mode !== "strict" && mode !== "permissive") {
      return { config: DEFAULT_CONFIG, valid: false, error: "config.mode must be strict or permissive" };
    }
    return { config: { mode }, valid: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: DEFAULT_CONFIG, valid: true };
    }
    return {
      config: DEFAULT_CONFIG,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
