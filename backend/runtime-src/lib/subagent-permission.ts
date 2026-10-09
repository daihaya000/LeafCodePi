/**
 * Code タスクでのサブエージェント起動許可。
 * 設定画面（エージェント > エージェント運用）で選び、サーバーの web-settings.json が正本。
 * 未設定は「禁止」。
 */

export type SubagentPermission = "allow" | "deny";

/** `/api/settings/[key]` で保存するキー。 */
export const SUBAGENT_PERMISSION_SETTING_KEY = "code-subagent-permission";
export const DEFAULT_SUBAGENT_PERMISSION: SubagentPermission = "deny";

export function isSubagentPermission(value: unknown): value is SubagentPermission {
  return value === "allow" || value === "deny";
}

/** 未設定・不正値は既定の「禁止」として扱う。 */
export function parseSubagentPermission(value: unknown): SubagentPermission {
  return isSubagentPermission(value) ? value : DEFAULT_SUBAGENT_PERMISSION;
}
