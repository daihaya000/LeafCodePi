/**
 * メッセージ移動ボタン（ナビゲーター）の不透明度設定。
 * 本家 LeafCode と同じ localStorage 即時反映方式。サーバ同期は
 * 汎用 settings API が無いため行わない（ブラウザごとの設定）。
 */

export const SCROLL_BUTTON_OPACITY_EVENT = "webui:scroll-button-opacity";
export const DEFAULT_SCROLL_BUTTON_OPACITY = 0.6;
export const MIN_SCROLL_BUTTON_OPACITY = 0.2;
export const MAX_SCROLL_BUTTON_OPACITY = 1;
const STORAGE_KEY = "webui:scroll-button-opacity";

export function clampScrollButtonOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SCROLL_BUTTON_OPACITY;
  return Math.min(MAX_SCROLL_BUTTON_OPACITY, Math.max(MIN_SCROLL_BUTTON_OPACITY, value));
}

export function readScrollButtonOpacity(): number {
  if (typeof window === "undefined") return DEFAULT_SCROLL_BUTTON_OPACITY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value = Number(raw);
    return raw && Number.isFinite(value)
      ? clampScrollButtonOpacity(value)
      : DEFAULT_SCROLL_BUTTON_OPACITY;
  } catch {
    return DEFAULT_SCROLL_BUTTON_OPACITY;
  }
}

export function writeScrollButtonOpacity(value: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, String(clampScrollButtonOpacity(value)));
    window.dispatchEvent(new CustomEvent(SCROLL_BUTTON_OPACITY_EVENT));
  } catch {
    /* ignore */
  }
}

/** 他タブ・設定画面での変更を購読する。 */
export function subscribeScrollButtonOpacity(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(SCROLL_BUTTON_OPACITY_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SCROLL_BUTTON_OPACITY_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
