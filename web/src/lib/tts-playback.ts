/**
 * ブラウザ標準の Web Speech API (SpeechSynthesis) でタスク/Botの発言を読み上げる。
 * サーバー側の leafcode-tts 拡張（Windows SAPI）とは別系統の、per-task/per-bot なON/OFFトグル用。
 */

const STORAGE_PREFIX = "webui:tts-enabled:";

/** Markdown記法を落として読み上げやすくする。空文字なら読み飛ばす。 */
export function speakable(text: string): string {
  const cleaned = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\s]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>+\s*/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "";
}

/** SpeechSynthesis が使える環境でだけ読み上げる。非対応ブラウザ／SSRでは何もしない。 */
export function speakText(text: string): void {
  const clean = speakable(text);
  if (!clean || typeof window === "undefined" || !window.speechSynthesis) return;
  if (typeof SpeechSynthesisUtterance === "undefined") return;
  try {
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(clean));
  } catch {
    /* 読み上げ失敗は無視（音が出ないだけ） */
  }
}

/** 再生中・キュー済みの読み上げをすべて止める。トグルOFF時は必ず呼ぶ。 */
export function stopSpeaking(): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
}

export function readTaskTtsEnabled(id: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${id}`) === "1";
  } catch {
    return false;
  }
}

function storageKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

export function writeTaskTtsEnabled(id: string, enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(id), enabled ? "1" : "0");
    // 同一タブ内の別インスタンス（分割ペイン等）にも伝える。storage イベントは別タブにしか飛ばないため。
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey(id) }));
  } catch {
    /* private mode 等では永続できないだけ */
  }
}

/** 別タブ・別インスタンスでのトグル変更を購読する。解除関数を返す。 */
export function subscribeTaskTtsEnabled(id: string, onChange: (enabled: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const key = storageKey(id);
  const listener = (event: StorageEvent) => {
    if (event.key !== key) return;
    onChange(readTaskTtsEnabled(id));
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
