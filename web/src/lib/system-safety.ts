import type { PermissionMode } from "@/lib/permission-gate";

/** System safety hard-gate intensity. Boolean legacy values map to off/standard. */
export type SystemSafetyLevel = "off" | "low" | "standard" | "strict";

export const DEFAULT_SYSTEM_SAFETY_LEVEL: SystemSafetyLevel = "standard";

export const SYSTEM_SAFETY_LEVELS: readonly SystemSafetyLevel[] = [
  "off",
  "low",
  "standard",
  "strict",
] as const;

export const SYSTEM_SAFETY_LEVEL_OPTIONS: ReadonlyArray<{
  value: SystemSafetyLevel;
  label: string;
  description: string;
}> = [
  {
    value: "off",
    label: "無効",
    description: "調査・承認フローなし（保護パスと自己停止禁止は継続）",
  },
  {
    value: "low",
    label: "軽め",
    description: "停止・権限昇格・カーネル/ドライバ/boot/disk/firmware のみ、確認ダイアログ1回",
  },
  {
    value: "standard",
    label: "標準",
    description: "OS変更系をすべて対象に、確認ダイアログ1回（調査・計画は不要）",
  },
  {
    value: "strict",
    label: "厳格",
    description: "調査・影響/復旧計画・明示承認が必要（従来どおり）",
  },
];

export function isSystemSafetyLevel(value: unknown): value is SystemSafetyLevel {
  return value === "off" || value === "low" || value === "standard" || value === "strict";
}

/** Normalize persisted boolean/string/missing values to a level. Default is standard. */
export function parseSystemSafetyLevel(value: unknown): SystemSafetyLevel {
  if (value === false) return "off";
  if (value === true) return DEFAULT_SYSTEM_SAFETY_LEVEL;
  if (isSystemSafetyLevel(value)) return value;
  return DEFAULT_SYSTEM_SAFETY_LEVEL;
}

export function systemSafetyEnabled(level: SystemSafetyLevel): boolean {
  return level !== "off";
}

export function systemSafetyLevelIndex(level: SystemSafetyLevel): number {
  const index = SYSTEM_SAFETY_LEVELS.indexOf(level);
  return index >= 0 ? index : SYSTEM_SAFETY_LEVELS.indexOf(DEFAULT_SYSTEM_SAFETY_LEVEL);
}

export function systemSafetyLevelFromIndex(index: number): SystemSafetyLevel {
  return SYSTEM_SAFETY_LEVELS[index] ?? DEFAULT_SYSTEM_SAFETY_LEVEL;
}

export type PermissionGateStoredConfig = {
  mode: PermissionMode;
  systemSafety?: SystemSafetyLevel | boolean;
  sessions?: Record<string, PermissionMode>;
};
