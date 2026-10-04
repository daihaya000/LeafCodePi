/**
 * Code タスクのツール承認モード（権限承認）。
 * 設定画面（エンジン > アクセスと安全）で選び、サーバーの web-settings.json が正本。
 * ユーザーが開始した Code タスクへ適用し、未設定は「許可」。
 */

export type PermissionMode = "allow" | "ask" | "deny";

/** `/api/settings/[key]` で保存するキー。 */
export const PERMISSION_MODE_SETTING_KEY = "code-permission-mode";
export const DEFAULT_PERMISSION_MODE: PermissionMode = "allow";

export const PERMISSION_OPTIONS: {
  value: PermissionMode;
  label: string;
  title: string;
}[] = [
  {
    value: "allow",
    label: "許可",
    title: "通常の危険操作・画面操作は確認なし。システム安全ガード設定に応じて OS 等の変更を止めます",
  },
  {
    value: "ask",
    label: "確認",
    title: "危険な操作・画面操作の前に確認。システム安全ガード設定に応じて OS 等の変更を止めます",
  },
  {
    value: "deny",
    label: "拒否",
    title: "Bash / PowerShell / 画面操作をすべて拒否します（危険操作に限りません）",
  },
];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "allow" || value === "ask" || value === "deny";
}

/** 未設定・不正値は既定の「許可」として扱う。 */
export function parsePermissionMode(value: unknown): PermissionMode {
  return isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE;
}
