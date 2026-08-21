/**
 * サブエージェント起動の許可 / 禁止設定。
 * デフォルトは「禁止」（本家 LeafCode と同じ localStorage + CustomEvent 設計）。
 */

export type SubagentPermission = "allow" | "deny";

export const SUBAGENT_PERMISSION_STORAGE_KEY = "webui:subagent-permission";
export const SUBAGENT_PERMISSION_EVENT = "webui:subagent-permission";

export const SUBAGENT_PERMISSION_OPTIONS: {
  value: SubagentPermission;
  label: string;
  title: string;
}[] = [
  {
    value: "allow",
    label: "許可",
    title: "サブエージェントの起動を許可します",
  },
  {
    value: "deny",
    label: "禁止",
    title: "サブエージェントの起動を自動で拒否します",
  },
];

export function readSubagentPermission(): SubagentPermission {
  if (typeof window === "undefined") return "deny";
  try {
    const raw = localStorage.getItem(SUBAGENT_PERMISSION_STORAGE_KEY);
    if (raw === "allow" || raw === "deny") return raw;
  } catch {
    /* ignore */
  }
  return "deny";
}

export function writeSubagentPermission(mode: SubagentPermission): void {
  try {
    localStorage.setItem(SUBAGENT_PERMISSION_STORAGE_KEY, mode);
    window.dispatchEvent(new CustomEvent(SUBAGENT_PERMISSION_EVENT, { detail: mode }));
  } catch {
    /* ignore */
  }
}
