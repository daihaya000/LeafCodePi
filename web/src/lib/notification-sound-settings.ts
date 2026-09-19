import { createSettingSync } from "./setting-sync";

export type NotificationSoundType = "standard" | "soft" | "clear";

/**
 * 完了音の系統。Code（タスク）と Bot（1:1・ルーティン）で別の音を選べる。
 * 注意音（承認・質問）は共有で、code 側の種類を使う。
 */
export type NotificationSoundChannel = "code" | "bot";

export const NOTIFICATION_SOUND_TYPE_SETTING_KEY = "notification-sound-type";
export const NOTIFICATION_SOUND_BOT_TYPE_SETTING_KEY = "notification-sound-type-bot";
export const NOTIFICATION_SOUND_VOLUME_SETTING_KEY = "notification-sound-volume";
export const NOTIFICATION_SOUND_EVENT = "webui:notification-sound";

export const DEFAULT_NOTIFICATION_SOUND_TYPE: NotificationSoundType = "standard";
/** Bot 側の既定は Code と耳で区別できる音にする。 */
export const DEFAULT_BOT_NOTIFICATION_SOUND_TYPE: NotificationSoundType = "clear";
export const DEFAULT_NOTIFICATION_SOUND_VOLUME = 100;
export const MIN_NOTIFICATION_SOUND_VOLUME = 0;
export const MAX_NOTIFICATION_SOUND_VOLUME = 200;

/** 種類と音量のまとまり。サーバー同期・localStorage はこの単位で扱う。 */
export type NotificationSoundSettings = {
  code: NotificationSoundType;
  bot: NotificationSoundType;
  volume: number;
};

const TYPE_STORAGE_KEYS: Record<NotificationSoundChannel, string> = {
  code: "webui:notification-sound-type",
  bot: "webui:notification-sound-type-bot",
};
const VOLUME_STORAGE_KEY = "webui:notification-sound-volume";

const typeSyncs: Record<NotificationSoundChannel, ReturnType<typeof createSettingSync>> = {
  code: createSettingSync({
    storageKey: TYPE_STORAGE_KEYS.code,
    serverPath: `/api/settings/${NOTIFICATION_SOUND_TYPE_SETTING_KEY}`,
    eventName: NOTIFICATION_SOUND_EVENT,
  }),
  bot: createSettingSync({
    storageKey: TYPE_STORAGE_KEYS.bot,
    serverPath: `/api/settings/${NOTIFICATION_SOUND_BOT_TYPE_SETTING_KEY}`,
    eventName: NOTIFICATION_SOUND_EVENT,
  }),
};

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

export function defaultNotificationSoundType(
  channel: NotificationSoundChannel = "code",
): NotificationSoundType {
  return channel === "bot"
    ? DEFAULT_BOT_NOTIFICATION_SOUND_TYPE
    : DEFAULT_NOTIFICATION_SOUND_TYPE;
}

export function clampNotificationSoundVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_NOTIFICATION_SOUND_VOLUME;
  return Math.min(
    MAX_NOTIFICATION_SOUND_VOLUME,
    Math.max(MIN_NOTIFICATION_SOUND_VOLUME, Math.round(value)),
  );
}

export function readNotificationSoundType(
  channel: NotificationSoundChannel = "code",
): NotificationSoundType {
  const raw = typeSyncs[channel].read();
  return isNotificationSoundType(raw)
    ? raw
    : defaultNotificationSoundType(channel);
}

export function readNotificationSoundVolume(): number {
  const raw = volumeSync.read();
  if (raw === null) return DEFAULT_NOTIFICATION_SOUND_VOLUME;
  const value = Number(raw);
  return Number.isFinite(value)
    ? clampNotificationSoundVolume(value)
    : DEFAULT_NOTIFICATION_SOUND_VOLUME;
}

export function readNotificationSoundSettings(): NotificationSoundSettings {
  return {
    code: readNotificationSoundType("code"),
    bot: readNotificationSoundType("bot"),
    volume: readNotificationSoundVolume(),
  };
}

export function writeNotificationSoundType(
  type: NotificationSoundType,
  channel: NotificationSoundChannel = "code",
): void {
  typeSyncs[channel].write(
    isNotificationSoundType(type) ? type : defaultNotificationSoundType(channel),
  );
}

export function writeNotificationSoundVolume(value: number): void {
  volumeSync.write(String(clampNotificationSoundVolume(value)));
}

export function subscribeNotificationSound(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const onStorage = (event: StorageEvent) => {
    if (
      event.key === TYPE_STORAGE_KEYS.code ||
      event.key === TYPE_STORAGE_KEYS.bot ||
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
  settings: NotificationSoundSettings,
): Promise<void> {
  await typeSyncs.code.writeToServer(
    isNotificationSoundType(settings.code)
      ? settings.code
      : DEFAULT_NOTIFICATION_SOUND_TYPE,
  );
  await typeSyncs.bot.writeToServer(
    isNotificationSoundType(settings.bot)
      ? settings.bot
      : DEFAULT_BOT_NOTIFICATION_SOUND_TYPE,
  );
  await volumeSync.writeToServer(String(clampNotificationSoundVolume(settings.volume)));
}

export async function readNotificationSoundFromServer(): Promise<{
  code?: NotificationSoundType;
  bot?: NotificationSoundType;
  volume?: number;
}> {
  const [codeRaw, botRaw, volumeRaw] = await Promise.all([
    typeSyncs.code.readFromServer(),
    typeSyncs.bot.readFromServer(),
    volumeSync.readFromServer(),
  ]);
  const result: {
    code?: NotificationSoundType;
    bot?: NotificationSoundType;
    volume?: number;
  } = {};
  if (isNotificationSoundType(codeRaw)) result.code = codeRaw;
  if (isNotificationSoundType(botRaw)) result.bot = botRaw;

  const volume = Number(volumeRaw);
  if (volumeRaw !== null && Number.isFinite(volume)) {
    result.volume = clampNotificationSoundVolume(volume);
  }
  return result;
}

/** Reconcile the browser copy with the durable settings-table backup. */
export async function reconcileNotificationSound(): Promise<void> {
  const server = await readNotificationSoundFromServer();
  const local = readNotificationSoundSettings();
  const next: NotificationSoundSettings = { ...local };
  if (server.code !== undefined && server.code !== local.code) next.code = server.code;
  if (server.bot !== undefined && server.bot !== local.bot) next.bot = server.bot;
  if (server.volume !== undefined && server.volume !== local.volume) {
    next.volume = server.volume;
  }

  if (
    next.code !== local.code ||
    next.bot !== local.bot ||
    next.volume !== local.volume
  ) {
    if (next.code !== local.code) writeNotificationSoundType(next.code, "code");
    if (next.bot !== local.bot) writeNotificationSoundType(next.bot, "bot");
    if (next.volume !== local.volume) writeNotificationSoundVolume(next.volume);
    return;
  }

  const customized =
    local.code !== DEFAULT_NOTIFICATION_SOUND_TYPE ||
    local.bot !== DEFAULT_BOT_NOTIFICATION_SOUND_TYPE ||
    local.volume !== DEFAULT_NOTIFICATION_SOUND_VOLUME;
  if (customized) await syncNotificationSoundToServer(local);
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
