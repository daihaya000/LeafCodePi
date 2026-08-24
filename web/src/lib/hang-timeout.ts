export const HANG_TIMEOUT_SETTING_KEY = "hang-timeout";
export const HANG_TIMEOUT_EVENT = "webui:hang-timeout";
export const DEFAULT_HANG_TIMEOUT_MS = 5 * 60_000;
export const MIN_HANG_TIMEOUT_MS = 10_000;
export const MAX_HANG_TIMEOUT_MS = 30 * 60_000;
const STORAGE_KEY = "webui:hang-timeout";

export type AutoResumeMode = "same" | "continue";
export const AUTO_RESUME_MODE_SETTING_KEY = "auto-resume-mode";
export const AUTO_RESUME_MODE_EVENT = "webui:auto-resume-mode";
export const DEFAULT_AUTO_RESUME_MODE: AutoResumeMode = "same";
export const CONTINUE_PROMPT = "続けて";
const AUTO_RESUME_MODE_STORAGE_KEY = "webui:auto-resume-mode";

export function isAutoResumeMode(value: unknown): value is AutoResumeMode {
  return value === "same" || value === "continue";
}

export function autoResumePrompt(mode: AutoResumeMode, originalPrompt: string): string {
  return mode === "continue" ? CONTINUE_PROMPT : originalPrompt;
}

export function clampHangTimeoutMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HANG_TIMEOUT_MS;
  return Math.min(MAX_HANG_TIMEOUT_MS, Math.max(MIN_HANG_TIMEOUT_MS, Math.round(value)));
}

/** 通知文言用、例: `5分` / `30秒`。 */
export function formatHangTimeout(ms: number): string {
  const clamped = clampHangTimeoutMs(ms);
  if (clamped < 60_000) return `${Math.round(clamped / 1_000)}秒`;
  return `${Number((clamped / 60_000).toFixed(1))}分`;
}

export function readHangTimeoutMs(): number {
  if (typeof window === "undefined") return DEFAULT_HANG_TIMEOUT_MS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value = Number(raw);
    return raw && Number.isFinite(value) ? clampHangTimeoutMs(value) : DEFAULT_HANG_TIMEOUT_MS;
  } catch {
    return DEFAULT_HANG_TIMEOUT_MS;
  }
}

export function writeHangTimeoutMs(value: number): void {
  const normalized = clampHangTimeoutMs(value);
  try {
    localStorage.setItem(STORAGE_KEY, String(normalized));
    window.dispatchEvent(new CustomEvent(HANG_TIMEOUT_EVENT));
  } catch {
    /* ignore */
  }
}

export function readAutoResumeMode(): AutoResumeMode {
  if (typeof window === "undefined") return DEFAULT_AUTO_RESUME_MODE;
  try {
    const value = localStorage.getItem(AUTO_RESUME_MODE_STORAGE_KEY);
    return isAutoResumeMode(value) ? value : DEFAULT_AUTO_RESUME_MODE;
  } catch {
    return DEFAULT_AUTO_RESUME_MODE;
  }
}

export function writeAutoResumeMode(mode: AutoResumeMode): void {
  try {
    localStorage.setItem(AUTO_RESUME_MODE_STORAGE_KEY, mode);
    window.dispatchEvent(new CustomEvent(AUTO_RESUME_MODE_EVENT));
  } catch {
    /* ignore */
  }
}

export function subscribeHangTimeout(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(HANG_TIMEOUT_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(HANG_TIMEOUT_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
