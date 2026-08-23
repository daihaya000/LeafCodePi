import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export type CollaborationMode = "strict" | "permissive";
export const COLLABORATION_CHECK_IDS = ["typecheck", "test", "lint", "build"] as const;
export type CollaborationCheckId = (typeof COLLABORATION_CHECK_IDS)[number];
export type CollaborationCheck = { file: string; args: string[] };
export type CollaborationConfig = {
  mode: CollaborationMode;
  heartbeatMs: number;
  leaseTtlMs: number;
  stuckAfterMs: number;
  askTimeoutMs: number;
  activityLimit: number;
  checks: Record<CollaborationCheckId, CollaborationCheck>;
};
export type CollaborationConfigResult = {
  config: CollaborationConfig;
  valid: boolean;
  error?: string;
};

const DEFAULT_CHECKS: Record<CollaborationCheckId, CollaborationCheck> = {
  typecheck: { file: "npm", args: ["--prefix", "web", "run", "typecheck"] },
  test: { file: "npm", args: ["test"] },
  lint: { file: "npm", args: ["--prefix", "web", "run", "lint"] },
  build: { file: "npm", args: ["--prefix", "web", "run", "build"] },
};

export const DEFAULT_COLLABORATION_CONFIG: CollaborationConfig = {
  mode: "strict",
  heartbeatMs: 2_000,
  leaseTtlMs: 15_000,
  stuckAfterMs: 120_000,
  askTimeoutMs: 120_000,
  activityLimit: 200,
  checks: DEFAULT_CHECKS,
};

function cloneChecks(): Record<CollaborationCheckId, CollaborationCheck> {
  return Object.fromEntries(
    COLLABORATION_CHECK_IDS.map((id) => [id, { file: DEFAULT_CHECKS[id].file, args: [...DEFAULT_CHECKS[id].args] }]),
  ) as Record<CollaborationCheckId, CollaborationCheck>;
}

function readChecks(value: unknown): Record<CollaborationCheckId, CollaborationCheck> | undefined {
  if (value === undefined) return cloneChecks();
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const checks = cloneChecks();
  for (const [key, rawCheck] of Object.entries(value)) {
    if (!(COLLABORATION_CHECK_IDS as readonly string[]).includes(key)) return undefined;
    if (!rawCheck || typeof rawCheck !== "object" || Array.isArray(rawCheck)) return undefined;
    const check = rawCheck as { file?: unknown; args?: unknown };
    if (typeof check.file !== "string" || !check.file.trim() || check.file.length > 260 || check.file.includes("\0")) return undefined;
    if (!Array.isArray(check.args) || check.args.length > 64 || check.args.some((arg) => typeof arg !== "string" || arg.length > 2_000 || arg.includes("\0"))) return undefined;
    checks[key as CollaborationCheckId] = { file: check.file, args: [...check.args] as string[] };
  }
  return checks;
}

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

export function readCollaborationConfig(
  env: NodeJS.ProcessEnv = process.env,
): CollaborationConfigResult {
  try {
    const raw = JSON.parse(readFileSync(join(collaborationDataDir(env), "collaboration.json"), "utf8")) as unknown;
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
    const checks = readChecks(config.checks);
    if (heartbeatMs === undefined || leaseTtlMs === undefined || stuckAfterMs === undefined || askTimeoutMs === undefined || activityLimit === undefined || !checks) {
      return { config: DEFAULT_COLLABORATION_CONFIG, valid: false, error: "config timing and activity values are invalid" };
    }
    if (leaseTtlMs < heartbeatMs || stuckAfterMs < heartbeatMs) {
      return { config: DEFAULT_COLLABORATION_CONFIG, valid: false, error: "config lease and stuck thresholds must be at least heartbeatMs" };
    }
    return {
      config: { mode, heartbeatMs, leaseTtlMs, stuckAfterMs, askTimeoutMs, activityLimit, checks },
      valid: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: DEFAULT_COLLABORATION_CONFIG, valid: true };
    return {
      config: DEFAULT_COLLABORATION_CONFIG,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
