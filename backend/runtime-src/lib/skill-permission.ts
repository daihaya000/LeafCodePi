/**
 * Code タスクでのスキル使用許可。
 * 設定画面（エージェント > エージェント用スキル）で選び、サーバーの web-settings.json が正本。
 * Bot の会話は対象外（ボット用スキルで管理する）。未設定は「許可」。
 */

export type SkillPermission = "allow" | "deny";

/** `/api/settings/[key]` で保存するキー。 */
export const SKILL_PERMISSION_SETTING_KEY = "code-skill-permission";
export const DEFAULT_SKILL_PERMISSION: SkillPermission = "allow";

export function isSkillPermission(value: unknown): value is SkillPermission {
  return value === "allow" || value === "deny";
}

/** 未設定・不正値は既定の「許可」として扱う。 */
export function parseSkillPermission(value: unknown): SkillPermission {
  return isSkillPermission(value) ? value : DEFAULT_SKILL_PERMISSION;
}
