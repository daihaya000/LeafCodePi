const KEY = "leafcodepi.selectedAccount";

/**
 * Home Composer で選択したアカウント（docs/plans/multi-account.md）。
 * null = 既定（~/.pi/agent/auth.json）。localStorage に永続化し次回起動時も引き継ぐ。
 */
export function readSelectedAccountId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function writeSelectedAccountId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
