/**
 * 設定の合成エンジン（AivisSpeech / Qwen3-TTS 等）の音声をブラウザで再生する。
 * per-task/per-bot なON/OFFトグル用。サーバー側の leafcode-tts 拡張（Windows SAPI、CLI用）とは別系統。
 */
import { apiUrl } from "./client";

const STORAGE_PREFIX = "webui:tts-enabled:";
const PLAYBACK_RATE_KEY = "webui:tts-playback-rate";
const PLAYBACK_VOLUME_KEY = "webui:tts-playback-volume";

export const DEFAULT_PLAYBACK_RATE = 1;
export const DEFAULT_PLAYBACK_VOLUME = 100;
/** HTMLAudio の実用範囲。話速 0.5〜2倍、音量 0〜100%。 */
export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 2;

export function clampPlaybackRate(value: unknown): number {
  const rate = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_PLAYBACK_RATE;
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate));
}

export function clampPlaybackVolume(value: unknown): number {
  const volume = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_PLAYBACK_VOLUME;
  return Math.min(100, Math.max(0, volume));
}

export function readPlaybackRate(): number {
  if (typeof window === "undefined") return DEFAULT_PLAYBACK_RATE;
  try {
    const raw = window.localStorage.getItem(PLAYBACK_RATE_KEY);
    if (raw === null) return DEFAULT_PLAYBACK_RATE;
    return clampPlaybackRate(Number(raw));
  } catch {
    return DEFAULT_PLAYBACK_RATE;
  }
}

export function writePlaybackRate(rate: number): number {
  const next = clampPlaybackRate(rate);
  if (typeof window === "undefined") return next;
  try {
    window.localStorage.setItem(PLAYBACK_RATE_KEY, String(next));
  } catch {
    /* private mode 等では永続できないだけ */
  }
  return next;
}

export function readPlaybackVolume(): number {
  if (typeof window === "undefined") return DEFAULT_PLAYBACK_VOLUME;
  try {
    const raw = window.localStorage.getItem(PLAYBACK_VOLUME_KEY);
    if (raw === null) return DEFAULT_PLAYBACK_VOLUME;
    return clampPlaybackVolume(Number(raw));
  } catch {
    return DEFAULT_PLAYBACK_VOLUME;
  }
}

export function writePlaybackVolume(volume: number): number {
  const next = clampPlaybackVolume(volume);
  if (typeof window === "undefined") return next;
  try {
    window.localStorage.setItem(PLAYBACK_VOLUME_KEY, String(next));
  } catch {
    /* private mode 等では永続できないだけ */
  }
  return next;
}

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
let cancelPlaybackRetry: (() => void) | null = null;

function clearPlaybackRetry(): void {
  cancelPlaybackRetry?.();
  cancelPlaybackRetry = null;
}

function retryPlaybackAfterUserGesture(
  audio: HTMLAudioElement,
  callbacks?: { onError?: (message: string) => void; onPlayed?: () => void },
): void {
  if (typeof document === "undefined") return;
  clearPlaybackRetry();
  const retry = () => {
    if (currentAudio !== audio) {
      clearPlaybackRetry();
      return;
    }
    void audio.play()
      .then(() => {
        clearPlaybackRetry();
        callbacks?.onPlayed?.();
      })
      .catch((error: unknown) => {
        if (errorName(error) === "NotAllowedError") return;
        clearPlaybackRetry();
        callbacks?.onError?.(error instanceof Error ? error.message : "読み上げに失敗しました");
      });
  };
  const options = { capture: true } as const;
  document.addEventListener("pointerdown", retry, options);
  document.addEventListener("keydown", retry, options);
  cancelPlaybackRetry = () => {
    document.removeEventListener("pointerdown", retry, options);
    document.removeEventListener("keydown", retry, options);
  };
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/** 再生中・取得中の読み上げをすべて止める。トグルOFF時は必ず呼ぶ。 */
export function stopSpeaking(): void {
  if (typeof window === "undefined") return;
  clearPlaybackRetry();
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
  let audio: HTMLAudioElement | null = null;
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
      audio = new Audio(currentObjectUrl);
      audio.playbackRate = readPlaybackRate();
      audio.volume = readPlaybackVolume() / 100;
      currentAudio = audio;
      audio.onended = () => {
        if (currentAudio === audio) stopSpeaking();
      };
      await audio.play();
      callbacks?.onPlayed?.();
    } catch (error) {
      if (errorName(error) === "AbortError") return;
      if (currentAbort === controller) currentAbort = null;
      if (errorName(error) === "NotAllowedError") {
        if (audio) retryPlaybackAfterUserGesture(audio, callbacks);
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
