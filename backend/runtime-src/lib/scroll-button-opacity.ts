import { createSettingSync } from "@/lib/setting-sync";

/**
 * メッセージ移動ボタン（ナビゲーター）の不透明度設定。
 * サーバ settings 表が正本、localStorage は同期読み取り用キャッシュ。
 */

export const SCROLL_BUTTON_OPACITY_EVENT = "webui:scroll-button-opacity";
export const SCROLL_BUTTON_OPACITY_SETTING_KEY = "scroll-button-opacity";
export const DEFAULT_SCROLL_BUTTON_OPACITY = 0.6;
export const MIN_SCROLL_BUTTON_OPACITY = 0.2;
export const MAX_SCROLL_BUTTON_OPACITY = 1;
const STORAGE_KEY = "webui:scroll-button-opacity";

const sync = createSettingSync({
  storageKey: STORAGE_KEY,
  serverPath: `/api/settings/${SCROLL_BUTTON_OPACITY_SETTING_KEY}`,
  eventName: SCROLL_BUTTON_OPACITY_EVENT,
});

export function clampScrollButtonOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SCROLL_BUTTON_OPACITY;
  return Math.min(MAX_SCROLL_BUTTON_OPACITY, Math.max(MIN_SCROLL_BUTTON_OPACITY, value));
}

export function readScrollButtonOpacity(): number {
  const raw = sync.read();
  const value = Number(raw);
  return raw && Number.isFinite(value)
    ? clampScrollButtonOpacity(value)
    : DEFAULT_SCROLL_BUTTON_OPACITY;
}

export function writeScrollButtonOpacity(value: number): void {
  const next = String(clampScrollButtonOpacity(value));
  sync.write(next);
  void sync.writeToServer(next);
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
