import { createSettingSync } from "./setting-sync";

export const TITLE_AUTO_UPDATE_FREQUENCY_SETTING_KEY = "title-auto-update-frequency";
export const TITLE_AUTO_UPDATE_FREQUENCY_EVENT = "webui:title-auto-update-frequency";
export const DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY = 5;
export const MIN_TITLE_AUTO_UPDATE_FREQUENCY = 1;
export const MAX_TITLE_AUTO_UPDATE_FREQUENCY = 100;
const TITLE_AUTO_UPDATE_FREQUENCY_STORAGE_KEY = "webui:title-auto-update-frequency";

const sync = createSettingSync({
  storageKey: TITLE_AUTO_UPDATE_FREQUENCY_STORAGE_KEY,
  serverPath: `/api/settings/${TITLE_AUTO_UPDATE_FREQUENCY_SETTING_KEY}`,
  eventName: TITLE_AUTO_UPDATE_FREQUENCY_EVENT,
});

function normalizedFrequency(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(number) && number >= MIN_TITLE_AUTO_UPDATE_FREQUENCY && number <= MAX_TITLE_AUTO_UPDATE_FREQUENCY
    ? number
    : null;
}

export function isTitleAutoUpdateFrequency(value: unknown): value is number {
  return normalizedFrequency(value) !== null;
}

export function parseTitleAutoUpdateFrequency(value: unknown): number {
  return normalizedFrequency(value) ?? DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY;
}

export function clampTitleAutoUpdateFrequency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY;
  return Math.min(MAX_TITLE_AUTO_UPDATE_FREQUENCY, Math.max(MIN_TITLE_AUTO_UPDATE_FREQUENCY, Math.round(value)));
}

/** 会話の完了ターン数が設定した間隔に達したかを判定する。 */
export function shouldAutoUpdateTitle(turnCount: number, frequency: number): boolean {
  const interval = parseTitleAutoUpdateFrequency(frequency);
  return Number.isInteger(turnCount) && turnCount > 0 && turnCount % interval === 0;
}

export function readTitleAutoUpdateFrequency(): number {
  return parseTitleAutoUpdateFrequency(sync.read());
}

export function writeTitleAutoUpdateFrequency(value: number): void {
  sync.write(String(clampTitleAutoUpdateFrequency(value)));
}

export function hasStoredTitleAutoUpdateFrequency(): boolean {
  return isTitleAutoUpdateFrequency(sync.read());
}

export function subscribeTitleAutoUpdateFrequency(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === TITLE_AUTO_UPDATE_FREQUENCY_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(TITLE_AUTO_UPDATE_FREQUENCY_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(TITLE_AUTO_UPDATE_FREQUENCY_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export async function readTitleAutoUpdateFrequencyFromServer(): Promise<string | null> {
  return sync.readFromServer();
}

export async function writeTitleAutoUpdateFrequencyToServer(value: number): Promise<void> {
  await sync.writeToServer(String(clampTitleAutoUpdateFrequency(value)));
}
