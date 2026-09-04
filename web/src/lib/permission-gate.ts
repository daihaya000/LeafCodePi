/**
 * Pi ツール実行の承認/確認モード。
 * 本家 LeafCode のサブエージェント許可設定と同じ localStorage + CustomEvent 設計。
 */

export type PermissionMode = "allow" | "ask" | "deny";

export const PERMISSION_STORAGE_KEY = "webui:permission-mode";
export const PERMISSION_EVENT = "webui:permission-mode";

export const PERMISSION_OPTIONS: {
  value: PermissionMode;
  label: string;
  title: string;
}[] = [
  {
    value: "allow",
    label: "許可",
    title: "通常の危険操作は確認なし。システム安全ガードの度合いに応じて OS 等の変更を止めます",
  },
  {
    value: "ask",
    label: "確認",
    title: "危険な操作の前に確認。システム安全ガードの度合いに応じて OS 等の変更を止めます",
  },
  {
    value: "deny",
    label: "拒否",
    title: "Bash / PowerShell ツールの実行をすべて拒否します（危険コマンドに限りません）",
  },
];

export function readPermissionMode(): PermissionMode {
  if (typeof window === "undefined") return "allow";
  try {
    const raw = localStorage.getItem(PERMISSION_STORAGE_KEY);
    if (raw === "allow" || raw === "ask" || raw === "deny") return raw;
  } catch {
    /* ignore */
  }
  return "allow";
}

export function writePermissionMode(mode: PermissionMode): void {
  try {
    localStorage.setItem(PERMISSION_STORAGE_KEY, mode);
    window.dispatchEvent(new CustomEvent(PERMISSION_EVENT, { detail: mode }));
  } catch {
    /* ignore */
  }
}
