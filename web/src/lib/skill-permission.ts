/**
 * Composer からのスキル使用許可。
 * 本家 LeafCode と同じ localStorage + CustomEvent 設計で、既定値は許可。
 */

export type SkillPermission = "allow" | "deny";

export const SKILL_PERMISSION_STORAGE_KEY = "webui:skill-permission";
export const SKILL_PERMISSION_EVENT = "webui:skill-permission";

export const SKILL_PERMISSION_OPTIONS: {
  value: SkillPermission;
  label: string;
  title: string;
}[] = [
  {
    value: "allow",
    label: "許可",
    title: "スキルの使用を許可します",
  },
  {
    value: "deny",
    label: "禁止",
    title: "スキルの使用を自動で拒否します",
  },
];

export function readSkillPermission(): SkillPermission {
  if (typeof window === "undefined") return "allow";
  try {
    const raw = localStorage.getItem(SKILL_PERMISSION_STORAGE_KEY);
    if (raw === "allow" || raw === "deny") return raw;
  } catch {
    /* ignore */
  }
  return "allow";
}

export function writeSkillPermission(mode: SkillPermission): void {
  try {
    localStorage.setItem(SKILL_PERMISSION_STORAGE_KEY, mode);
    window.dispatchEvent(new CustomEvent(SKILL_PERMISSION_EVENT, { detail: mode }));
  } catch {
    /* ignore */
  }
}
