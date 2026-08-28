export type CollaborationMode = "strict" | "permissive" | "off";
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
export type CollaborationConfigSnapshot = CollaborationConfigResult & {
  path: string;
  exists: boolean;
};

export const COLLABORATION_LIMITS = {
  heartbeatMs: { min: 250, max: 60_000 },
  leaseTtlMs: { min: 1_000, max: 300_000 },
  stuckAfterMs: { min: 1_000, max: 3_600_000 },
  askTimeoutMs: { min: 1_000, max: 3_600_000 },
  activityLimit: { min: 1, max: 1_000 },
} as const;

const DEFAULT_CHECKS: Record<CollaborationCheckId, CollaborationCheck> = {
  typecheck: { file: "npm", args: ["--prefix", "web", "run", "typecheck"] },
  test: { file: "npm", args: ["test"] },
  lint: { file: "npm", args: ["--prefix", "web", "run", "lint"] },
  build: { file: "npm", args: ["--prefix", "web", "run", "build"] },
};

export const DEFAULT_COLLABORATION_CONFIG: CollaborationConfig = {
  mode: "off",
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

function cloneConfig(config: CollaborationConfig): CollaborationConfig {
  return {
    mode: config.mode,
    heartbeatMs: config.heartbeatMs,
    leaseTtlMs: config.leaseTtlMs,
    stuckAfterMs: config.stuckAfterMs,
    askTimeoutMs: config.askTimeoutMs,
    activityLimit: config.activityLimit,
    checks: Object.fromEntries(
      COLLABORATION_CHECK_IDS.map((id) => [id, { file: config.checks[id].file, args: [...config.checks[id].args] }]),
    ) as Record<CollaborationCheckId, CollaborationCheck>,
  };
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
  key: keyof typeof COLLABORATION_LIMITS,
): number | undefined {
  const value = raw[key];
  if (value === undefined) return DEFAULT_COLLABORATION_CONFIG[key];
  const { min, max } = COLLABORATION_LIMITS[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return undefined;
  return value;
}

export function parseCollaborationConfig(raw: unknown): CollaborationConfigResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: cloneConfig(DEFAULT_COLLABORATION_CONFIG), valid: false, error: "config must be an object" };
  }
  const config = raw as Record<string, unknown>;
  const mode = config.mode;
  if (mode === undefined) {
    return { config: cloneConfig(DEFAULT_COLLABORATION_CONFIG), valid: false, error: "config.mode is required" };
  }
  if (mode !== "strict" && mode !== "permissive" && mode !== "off") {
    return { config: cloneConfig(DEFAULT_COLLABORATION_CONFIG), valid: false, error: "config.mode must be strict, permissive, or off" };
  }
  const heartbeatMs = numberConfig(config, "heartbeatMs");
  const leaseTtlMs = numberConfig(config, "leaseTtlMs");
  const stuckAfterMs = numberConfig(config, "stuckAfterMs");
  const askTimeoutMs = numberConfig(config, "askTimeoutMs");
  const activityLimit = numberConfig(config, "activityLimit");
  const checks = readChecks(config.checks);
  if (heartbeatMs === undefined || leaseTtlMs === undefined || stuckAfterMs === undefined || askTimeoutMs === undefined || activityLimit === undefined || !checks) {
    return { config: cloneConfig(DEFAULT_COLLABORATION_CONFIG), valid: false, error: "config timing and activity values are invalid" };
  }
  if (leaseTtlMs < heartbeatMs || stuckAfterMs < heartbeatMs) {
    return { config: cloneConfig(DEFAULT_COLLABORATION_CONFIG), valid: false, error: "config lease and stuck thresholds must be at least heartbeatMs" };
  }
  return {
    config: { mode, heartbeatMs, leaseTtlMs, stuckAfterMs, askTimeoutMs, activityLimit, checks },
    valid: true,
  };
}

export function formatCheckArgs(args: string[]): string {
  return args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

export function parseCheckArgs(input: string): string[] | undefined {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string" || arg.length > 2_000 || arg.includes("\0"))) return undefined;
      if (parsed.length > 64) return undefined;
      return parsed as string[];
    } catch {
      return undefined;
    }
  }
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of trimmed) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) return undefined;
  if (current) args.push(current);
  if (args.length > 64 || args.some((arg) => arg.length > 2_000 || arg.includes("\0"))) return undefined;
  return args;
}
