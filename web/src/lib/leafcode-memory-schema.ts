export type MemoryMode = "policy-only" | "legacy-inject";
export type MemoryPolicyStyle = "full" | "compact" | "custom" | "none";
export type SessionSearchVariant = "legacy" | "anchors";
export type ReviewTransport = "direct" | "subprocess";
export type MemoryOverflowStrategy = "auto-consolidate" | "reject" | "fifo-evict";
export type MemoryCategory = "failure" | "correction" | "insight" | "preference" | "convention" | "tool-quirk";

export type MemorySearchEntry = {
  project: string | null;
  target: "memory" | "user" | "failure";
  category: MemoryCategory | null;
  content: string;
  created: string;
  lastReferenced: string;
};

export type MemorySearchResponse = {
  results: MemorySearchEntry[];
};

export type LeafCodeMemorySettings = {
  memoryMode: MemoryMode;
  memoryPolicyStyle: MemoryPolicyStyle;
  memoryCharLimit: number;
  userCharLimit: number;
  projectCharLimit: number;
  sessionSearchVariant: SessionSearchVariant;
  reviewEnabled: boolean;
  reviewTransport: ReviewTransport;
  reviewRecentMessages: number;
  nudgeInterval: number;
  nudgeToolCalls: number;
  correctionDetection: boolean;
  standingInstructionsEnabled: boolean;
  memoryOverflowStrategy: MemoryOverflowStrategy;
  overflowGraceMs: number;
  consolidationTimeoutMs: number;
  autoConsolidationWarnOnFailure: boolean;
  flushOnCompact: boolean;
  flushOnShutdown: boolean;
  flushMinTurns: number;
  flushRecentMessages: number;
  failureInjectionEnabled: boolean;
  failureInjectionMaxAgeDays: number;
  failureInjectionMaxEntries: number;
};

export type LeafCodeMemorySettingsSnapshot = {
  settings: LeafCodeMemorySettings;
  path: string;
  exists: boolean;
  valid: boolean;
  writable: boolean;
  error?: string;
};

export const MEMORY_SETTING_LIMITS = {
  charLimit: { min: 1_000, max: 100_000 },
  nudgeInterval: { min: 1, max: 1_000 },
  nudgeToolCalls: { min: 1, max: 10_000 },
  recentMessages: { min: 0, max: 1_000 },
  flushMinTurns: { min: 0, max: 1_000 },
  overflowGraceMs: { min: 0, max: 3_600_000 },
  consolidationTimeoutMs: { min: 10_000, max: 3_600_000 },
  failureInjectionMaxAgeDays: { min: 0, max: 3_650 },
  failureInjectionMaxEntries: { min: 0, max: 100 },
} as const;

export const DEFAULT_LEAFCODE_MEMORY_SETTINGS: LeafCodeMemorySettings = {
  memoryMode: "policy-only",
  memoryPolicyStyle: "compact",
  memoryCharLimit: 5_000,
  userCharLimit: 5_000,
  projectCharLimit: 5_000,
  sessionSearchVariant: "legacy",
  reviewEnabled: true,
  reviewTransport: "direct",
  reviewRecentMessages: 50,
  nudgeInterval: 10,
  nudgeToolCalls: 15,
  correctionDetection: true,
  standingInstructionsEnabled: true,
  memoryOverflowStrategy: "auto-consolidate",
  overflowGraceMs: 180_000,
  consolidationTimeoutMs: 180_000,
  autoConsolidationWarnOnFailure: true,
  flushOnCompact: false,
  flushOnShutdown: true,
  flushMinTurns: 6,
  flushRecentMessages: 50,
  failureInjectionEnabled: true,
  failureInjectionMaxAgeDays: 7,
  failureInjectionMaxEntries: 5,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T, key: string, errors: string[]): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && values.includes(value as T)) return value as T;
  errors.push(`${key} が不正です`);
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean, key: string, errors: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  errors.push(`${key} は boolean で指定してください`);
  return fallback;
}

function integerValue(value: unknown, fallback: number, range: { min: number; max: number }, key: string, errors: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max) return value;
  errors.push(`${key} は ${range.min}〜${range.max} の整数で指定してください`);
  return fallback;
}

export function parseLeafCodeMemorySettings(value: unknown): { settings: LeafCodeMemorySettings; errors: string[] } {
  if (!isRecord(value)) {
    return { settings: { ...DEFAULT_LEAFCODE_MEMORY_SETTINGS }, errors: ["設定はJSONオブジェクトである必要があります"] };
  }
  const errors: string[] = [];
  const defaults = DEFAULT_LEAFCODE_MEMORY_SETTINGS;
  return {
    settings: {
      memoryMode: enumValue(value.memoryMode, ["policy-only", "legacy-inject"], defaults.memoryMode, "memoryMode", errors),
      memoryPolicyStyle: enumValue(value.memoryPolicyStyle, ["full", "compact", "custom", "none"], defaults.memoryPolicyStyle, "memoryPolicyStyle", errors),
      memoryCharLimit: integerValue(value.memoryCharLimit, defaults.memoryCharLimit, MEMORY_SETTING_LIMITS.charLimit, "memoryCharLimit", errors),
      userCharLimit: integerValue(value.userCharLimit, defaults.userCharLimit, MEMORY_SETTING_LIMITS.charLimit, "userCharLimit", errors),
      projectCharLimit: integerValue(value.projectCharLimit, defaults.projectCharLimit, MEMORY_SETTING_LIMITS.charLimit, "projectCharLimit", errors),
      sessionSearchVariant: enumValue(value.sessionSearchVariant, ["legacy", "anchors"], defaults.sessionSearchVariant, "sessionSearchVariant", errors),
      reviewEnabled: booleanValue(value.reviewEnabled, defaults.reviewEnabled, "reviewEnabled", errors),
      reviewTransport: enumValue(value.reviewTransport, ["direct", "subprocess"], defaults.reviewTransport, "reviewTransport", errors),
      reviewRecentMessages: integerValue(value.reviewRecentMessages, defaults.reviewRecentMessages, MEMORY_SETTING_LIMITS.recentMessages, "reviewRecentMessages", errors),
      nudgeInterval: integerValue(value.nudgeInterval, defaults.nudgeInterval, MEMORY_SETTING_LIMITS.nudgeInterval, "nudgeInterval", errors),
      nudgeToolCalls: integerValue(value.nudgeToolCalls, defaults.nudgeToolCalls, MEMORY_SETTING_LIMITS.nudgeToolCalls, "nudgeToolCalls", errors),
      correctionDetection: booleanValue(value.correctionDetection, defaults.correctionDetection, "correctionDetection", errors),
      standingInstructionsEnabled: booleanValue(value.standingInstructionsEnabled, defaults.standingInstructionsEnabled, "standingInstructionsEnabled", errors),
      memoryOverflowStrategy: enumValue(value.memoryOverflowStrategy, ["auto-consolidate", "reject", "fifo-evict"], defaults.memoryOverflowStrategy, "memoryOverflowStrategy", errors),
      overflowGraceMs: integerValue(value.overflowGraceMs, defaults.overflowGraceMs, MEMORY_SETTING_LIMITS.overflowGraceMs, "overflowGraceMs", errors),
      consolidationTimeoutMs: integerValue(value.consolidationTimeoutMs, defaults.consolidationTimeoutMs, MEMORY_SETTING_LIMITS.consolidationTimeoutMs, "consolidationTimeoutMs", errors),
      autoConsolidationWarnOnFailure: booleanValue(value.autoConsolidationWarnOnFailure, defaults.autoConsolidationWarnOnFailure, "autoConsolidationWarnOnFailure", errors),
      flushOnCompact: booleanValue(value.flushOnCompact, defaults.flushOnCompact, "flushOnCompact", errors),
      flushOnShutdown: booleanValue(value.flushOnShutdown, defaults.flushOnShutdown, "flushOnShutdown", errors),
      flushMinTurns: integerValue(value.flushMinTurns, defaults.flushMinTurns, MEMORY_SETTING_LIMITS.flushMinTurns, "flushMinTurns", errors),
      flushRecentMessages: integerValue(value.flushRecentMessages, defaults.flushRecentMessages, MEMORY_SETTING_LIMITS.recentMessages, "flushRecentMessages", errors),
      failureInjectionEnabled: booleanValue(value.failureInjectionEnabled, defaults.failureInjectionEnabled, "failureInjectionEnabled", errors),
      failureInjectionMaxAgeDays: integerValue(value.failureInjectionMaxAgeDays, defaults.failureInjectionMaxAgeDays, MEMORY_SETTING_LIMITS.failureInjectionMaxAgeDays, "failureInjectionMaxAgeDays", errors),
      failureInjectionMaxEntries: integerValue(value.failureInjectionMaxEntries, defaults.failureInjectionMaxEntries, MEMORY_SETTING_LIMITS.failureInjectionMaxEntries, "failureInjectionMaxEntries", errors),
    },
    errors,
  };
}
