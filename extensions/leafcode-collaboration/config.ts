import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LeafCodeCollaborationMode } from "./contract.ts";

export type CollaborationConfig = {
  mode: LeafCodeCollaborationMode;
  heartbeatMs: number;
  leaseTtlMs: number;
  stuckAfterMs: number;
  askTimeoutMs: number;
  activityLimit: number;
};

export type CollaborationConfigResult = {
  config: CollaborationConfig;
  valid: boolean;
  error?: string;
};

export const DEFAULT_COLLABORATION_CONFIG: CollaborationConfig = {
  mode: "strict",
  heartbeatMs: 2_000,
  leaseTtlMs: 15_000,
  stuckAfterMs: 120_000,
  askTimeoutMs: 120_000,
  activityLimit: 200,
};

function numberConfig(
  raw: Record<string, unknown>,
  key: keyof Pick<CollaborationConfig, "heartbeatMs" | "leaseTtlMs" | "stuckAfterMs" | "askTimeoutMs" | "activityLimit">,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = raw[key];
  if (value === undefined) return DEFAULT_COLLABORATION_CONFIG[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return undefined;
  return value;
}

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
      return { config: DEFAULT_COLLABORATION_CONFIG, valid: false, error: "config must be an object" };
    }
    const config = raw as Record<string, unknown>;
    const mode = config.mode;
    if (mode === undefined) {
      return { config: DEFAULT_COLLABORATION_CONFIG, valid: false, error: "config.mode is required" };
    }
    if (mode !== "strict" && mode !== "permissive") {
      return { config: DEFAULT_COLLABORATION_CONFIG, valid: false, error: "config.mode must be strict or permissive" };
    }
    const heartbeatMs = numberConfig(config, "heartbeatMs", 250, 60_000);
    const leaseTtlMs = numberConfig(config, "leaseTtlMs", 1_000, 300_000);
    const stuckAfterMs = numberConfig(config, "stuckAfterMs", 1_000, 3_600_000);
    const askTimeoutMs = numberConfig(config, "askTimeoutMs", 1_000, 3_600_000);
    const activityLimit = numberConfig(config, "activityLimit", 1, 1_000);
    if (heartbeatMs === undefined || leaseTtlMs === undefined || stuckAfterMs === undefined || askTimeoutMs === undefined || activityLimit === undefined) {
      return { config: DEFAULT_COLLABORATION_CONFIG, valid: false, error: "config timing and activity values are invalid" };
    }
    if (leaseTtlMs < heartbeatMs || stuckAfterMs < heartbeatMs) {
      return { config: DEFAULT_COLLABORATION_CONFIG, valid: false, error: "config lease and stuck thresholds must be at least heartbeatMs" };
    }
    return {
      config: { mode, heartbeatMs, leaseTtlMs, stuckAfterMs, askTimeoutMs, activityLimit },
      valid: true,
    };
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
