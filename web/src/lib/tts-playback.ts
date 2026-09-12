/**
 * 設定の合成エンジン（AivisSpeech / Qwen3-TTS 等）の音声をブラウザで再生する。
 * per-task/per-bot なON/OFFトグル用。サーバー側の leafcode-tts 拡張（Windows SAPI、CLI用）とは別系統。
 */
import { apiUrl } from "./client";

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

let currentAudio: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;
let currentAbort: AbortController | null = null;

/** 再生中・取得中の読み上げをすべて止める。トグルOFF時は必ず呼ぶ。 */
export function stopSpeaking(): void {
  if (typeof window === "undefined") return;
  currentAbort?.abort();
  currentAbort = null;
  currentAudio?.pause();
  currentAudio = null;
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

/**
 * 合成APIで音声を作りブラウザで再生する。失敗時（未設定・停止中など）は onError に日本語メッセージを返す。
 * フォールバックの機械音声は出さない。
 */
export function speakText(text: string, callbacks?: { onError?: (message: string) => void; onPlayed?: () => void }): void {
  const clean = speakable(text);
  if (!clean || typeof window === "undefined" || typeof Audio === "undefined") return;
  // 直前の再生・取得を止めて最新を優先する。
  stopSpeaking();
  const controller = new AbortController();
  currentAbort = controller;
  void (async () => {
    try {
      const res = await fetch(apiUrl("/api/tts/synthesize"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: clean }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? `合成に失敗しました (${res.status})`);
      }
      const blob = await res.blob();
      if (controller.signal.aborted) return;
      currentObjectUrl = URL.createObjectURL(blob);
      const audio = new Audio(currentObjectUrl);
      currentAudio = audio;
      audio.onended = () => {
        if (currentAudio === audio) stopSpeaking();
      };
      await audio.play();
      callbacks?.onPlayed?.();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      if (currentAbort === controller) currentAbort = null;
      if (error instanceof Error && error.name === "NotAllowedError") {
        callbacks?.onError?.("ブラウザが自動再生をブロックしました（ページをクリック後に再試行）");
      } else {
        callbacks?.onError?.(error instanceof Error ? error.message : "読み上げに失敗しました");
      }
    }
  })();
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
