import { createSettingSync } from "./setting-sync";

export const TITLE_AUTO_UPDATE_FREQUENCY_SETTING_KEY = "title-auto-update-frequency";
export const TITLE_AUTO_UPDATE_FREQUENCY_EVENT = "webui:title-auto-update-frequency";
export const DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY = 5;
export const MIN_TITLE_AUTO_UPDATE_FREQUENCY = 1;
export const MAX_TITLE_AUTO_UPDATE_FREQUENCY = 100;
const TITLE_AUTO_UPDATE_FREQUENCY_STORAGE_KEY = "webui:title-auto-update-frequency";

export const TITLE_AUTO_UPDATE_ENABLED_SETTING_KEY = "title-auto-update-enabled";
export const TITLE_AUTO_UPDATE_ENABLED_EVENT = "webui:title-auto-update-enabled";
export const DEFAULT_TITLE_AUTO_UPDATE_ENABLED = false;
const TITLE_AUTO_UPDATE_ENABLED_STORAGE_KEY = "webui:title-auto-update-enabled";

const sync = createSettingSync({
  storageKey: TITLE_AUTO_UPDATE_FREQUENCY_STORAGE_KEY,
  serverPath: `/api/settings/${TITLE_AUTO_UPDATE_FREQUENCY_SETTING_KEY}`,
  eventName: TITLE_AUTO_UPDATE_FREQUENCY_EVENT,
});

const enabledSync = createSettingSync({
  storageKey: TITLE_AUTO_UPDATE_ENABLED_STORAGE_KEY,
  serverPath: `/api/settings/${TITLE_AUTO_UPDATE_ENABLED_SETTING_KEY}`,
  eventName: TITLE_AUTO_UPDATE_ENABLED_EVENT,
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

export function isTitleAutoUpdateEnabledSetting(value: unknown): value is "0" | "1" {
  return value === "0" || value === "1";
}

export function parseTitleAutoUpdateEnabled(value: unknown): boolean {
  if (value === true || value === "1") return true;
  if (value === false || value === "0") return false;
  return DEFAULT_TITLE_AUTO_UPDATE_ENABLED;
}

/** タスク個別の指定があればそれを優先し、未設定なら設定デフォルトを使う。 */
export function resolveTitleAutoUpdateEnabled(
  taskValue: boolean | undefined,
  defaultEnabled: boolean,
): boolean {
  return taskValue ?? defaultEnabled;
}

export function readTitleAutoUpdateEnabled(): boolean {
  return parseTitleAutoUpdateEnabled(enabledSync.read());
}

export function writeTitleAutoUpdateEnabled(value: boolean): void {
  enabledSync.write(value ? "1" : "0");
}

export function hasStoredTitleAutoUpdateEnabled(): boolean {
  return isTitleAutoUpdateEnabledSetting(enabledSync.read());
}

export function subscribeTitleAutoUpdateEnabled(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === TITLE_AUTO_UPDATE_ENABLED_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(TITLE_AUTO_UPDATE_ENABLED_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(TITLE_AUTO_UPDATE_ENABLED_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export async function readTitleAutoUpdateEnabledFromServer(): Promise<string | null> {
  return enabledSync.readFromServer();
}

export async function writeTitleAutoUpdateEnabledToServer(value: boolean): Promise<void> {
  await enabledSync.writeToServer(value ? "1" : "0");
}
