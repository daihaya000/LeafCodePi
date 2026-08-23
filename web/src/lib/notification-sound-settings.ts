import { createSettingSync } from "./setting-sync";

export type NotificationSoundType = "standard" | "soft" | "clear";

export const NOTIFICATION_SOUND_TYPE_SETTING_KEY = "notification-sound-type";
export const NOTIFICATION_SOUND_VOLUME_SETTING_KEY = "notification-sound-volume";
export const NOTIFICATION_SOUND_EVENT = "webui:notification-sound";

export const DEFAULT_NOTIFICATION_SOUND_TYPE: NotificationSoundType = "standard";
export const DEFAULT_NOTIFICATION_SOUND_VOLUME = 100;
export const MIN_NOTIFICATION_SOUND_VOLUME = 0;
export const MAX_NOTIFICATION_SOUND_VOLUME = 200;

const TYPE_STORAGE_KEY = "webui:notification-sound-type";
const VOLUME_STORAGE_KEY = "webui:notification-sound-volume";

const typeSync = createSettingSync({
  storageKey: TYPE_STORAGE_KEY,
  serverPath: `/api/settings/${NOTIFICATION_SOUND_TYPE_SETTING_KEY}`,
  eventName: NOTIFICATION_SOUND_EVENT,
});

const volumeSync = createSettingSync({
  storageKey: VOLUME_STORAGE_KEY,
  serverPath: `/api/settings/${NOTIFICATION_SOUND_VOLUME_SETTING_KEY}`,
  eventName: NOTIFICATION_SOUND_EVENT,
});

const VALID_NOTIFICATION_SOUND_TYPES: readonly NotificationSoundType[] = [
  "standard",
  "soft",
  "clear",
];

export function isNotificationSoundType(
  value: unknown,
): value is NotificationSoundType {
  return (
    typeof value === "string" &&
    (VALID_NOTIFICATION_SOUND_TYPES as readonly string[]).includes(value)
  );
}

export function clampNotificationSoundVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_NOTIFICATION_SOUND_VOLUME;
  return Math.min(
    MAX_NOTIFICATION_SOUND_VOLUME,
    Math.max(MIN_NOTIFICATION_SOUND_VOLUME, Math.round(value)),
  );
}

export function readNotificationSoundType(): NotificationSoundType {
  const raw = typeSync.read();
  return isNotificationSoundType(raw)
    ? raw
    : DEFAULT_NOTIFICATION_SOUND_TYPE;
}

export function readNotificationSoundVolume(): number {
  const raw = volumeSync.read();
  if (raw === null) return DEFAULT_NOTIFICATION_SOUND_VOLUME;
  const value = Number(raw);
  return Number.isFinite(value)
    ? clampNotificationSoundVolume(value)
    : DEFAULT_NOTIFICATION_SOUND_VOLUME;
}

export function writeNotificationSoundType(type: NotificationSoundType): void {
  typeSync.write(isNotificationSoundType(type) ? type : DEFAULT_NOTIFICATION_SOUND_TYPE);
}

export function writeNotificationSoundVolume(value: number): void {
  volumeSync.write(String(clampNotificationSoundVolume(value)));
}

export function subscribeNotificationSound(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const onStorage = (event: StorageEvent) => {
    if (
      event.key === TYPE_STORAGE_KEY ||
      event.key === VOLUME_STORAGE_KEY ||
      event.key === null
    ) {
      listener();
    }
  };

  window.addEventListener(NOTIFICATION_SOUND_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(NOTIFICATION_SOUND_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export async function syncNotificationSoundToServer(
  type: NotificationSoundType,
  volume: number,
): Promise<void> {
  await typeSync.writeToServer(
    isNotificationSoundType(type) ? type : DEFAULT_NOTIFICATION_SOUND_TYPE,
  );
  await volumeSync.writeToServer(String(clampNotificationSoundVolume(volume)));
}

export async function readNotificationSoundFromServer(): Promise<{
  type?: NotificationSoundType;
  volume?: number;
}> {
  const [typeRaw, volumeRaw] = await Promise.all([
    typeSync.readFromServer(),
    volumeSync.readFromServer(),
  ]);
  const result: { type?: NotificationSoundType; volume?: number } = {};
  if (isNotificationSoundType(typeRaw)) result.type = typeRaw;

  const volume = Number(volumeRaw);
  if (volumeRaw !== null && Number.isFinite(volume)) {
    result.volume = clampNotificationSoundVolume(volume);
  }
  return result;
}

/** Reconcile the browser copy with the durable settings-table backup. */
export async function reconcileNotificationSound(): Promise<void> {
  const server = await readNotificationSoundFromServer();
  if (server.type !== undefined || server.volume !== undefined) {
    if (server.type !== undefined && server.type !== readNotificationSoundType()) {
      writeNotificationSoundType(server.type);
    }
    if (
      server.volume !== undefined &&
      server.volume !== readNotificationSoundVolume()
    ) {
      writeNotificationSoundVolume(server.volume);
    }
    return;
  }

  const type = readNotificationSoundType();
  const volume = readNotificationSoundVolume();
  if (
    type !== DEFAULT_NOTIFICATION_SOUND_TYPE ||
    volume !== DEFAULT_NOTIFICATION_SOUND_VOLUME
  ) {
    await syncNotificationSoundToServer(type, volume);
  }
}

export function notificationSoundTypeLabel(type: NotificationSoundType): string {
  switch (type) {
    case "soft":
      return "ソフト";
    case "clear":
      return "クリア";
    case "standard":
    default:
      return "標準";
  }
}
