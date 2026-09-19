import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import {
  clampNotificationSoundVolume,
  DEFAULT_BOT_NOTIFICATION_SOUND_TYPE,
  DEFAULT_NOTIFICATION_SOUND_TYPE,
  DEFAULT_NOTIFICATION_SOUND_VOLUME,
  MAX_NOTIFICATION_SOUND_VOLUME,
  isNotificationSoundType,
  notificationSoundTypeLabel,
  readNotificationSoundSettings,
  subscribeNotificationSound,
  syncNotificationSoundToServer,
  writeNotificationSoundType,
  writeNotificationSoundVolume,
  type NotificationSoundChannel,
  type NotificationSoundSettings as NotificationSoundConfig,
  type NotificationSoundType,
} from "@/lib/notification-sound-settings";
import {
  playAttentionRequiredSound,
  playSessionCompleteSound,
} from "@/lib/session-complete-sound";

const SERVER_SYNC_DELAY_MS = 400;

const SOUND_TYPES: NotificationSoundType[] = ["standard", "soft", "clear"];

const SOUND_CHANNEL_ROWS: {
  channel: NotificationSoundChannel;
  label: string;
  ariaLabel: string;
}[] = [
  { channel: "code", label: "Code（タスク）", ariaLabel: "Codeの通知音の種類" },
  { channel: "bot", label: "Bot（1:1・ルーティン）", ariaLabel: "Botの通知音の種類" },
];

export function NotificationSoundSettings() {
  // SSRとの一致を保つため初期値は定数固定とし、mount後にlocalStorageの保存値へ切り替える。
  const [soundTypes, setSoundTypes] = useState<
    Record<NotificationSoundChannel, NotificationSoundType>
  >(() => ({
    code: DEFAULT_NOTIFICATION_SOUND_TYPE,
    bot: DEFAULT_BOT_NOTIFICATION_SOUND_TYPE,
  }));
  const [volume, setVolume] = useState(DEFAULT_NOTIFICATION_SOUND_VOLUME);
  const latestRef = useRef<NotificationSoundConfig>({
    code: DEFAULT_NOTIFICATION_SOUND_TYPE,
    bot: DEFAULT_BOT_NOTIFICATION_SOUND_TYPE,
    volume: DEFAULT_NOTIFICATION_SOUND_VOLUME,
  });
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const apply = () => {
      const settings = readNotificationSoundSettings();
      latestRef.current = settings;
      setSoundTypes({ code: settings.code, bot: settings.bot });
      setVolume(settings.volume);
    };
    apply();
    return subscribeNotificationSound(apply);
  }, []);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current !== null) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
        void syncNotificationSoundToServer(latestRef.current);
      }
    };
  }, []);

  const scheduleServerSync = (next: NotificationSoundConfig) => {
    latestRef.current = next;
    if (syncTimerRef.current !== null) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      void syncNotificationSoundToServer(latestRef.current);
    }, SERVER_SYNC_DELAY_MS);
  };

  const changeSoundType = (channel: NotificationSoundChannel, value: string) => {
    if (!isNotificationSoundType(value)) return;
    const next = { ...latestRef.current, [channel]: value };
    setSoundTypes({ code: next.code, bot: next.bot });
    writeNotificationSoundType(value, channel);
    scheduleServerSync(next);
  };

  const changeVolume = (value: string) => {
    const nextVolume = clampNotificationSoundVolume(Number(value));
    const next = { ...latestRef.current, volume: nextVolume };
    setVolume(nextVolume);
    writeNotificationSoundVolume(nextVolume);
    scheduleServerSync(next);
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">通知音</h3>
      <p className="mt-1 text-xs text-muted">
        Codeの完了とBotの完了（1:1・ルーティン）で別の音を選べます。注意音（承認・質問）はCodeの種類を使います。
      </p>
      <div className="mt-4 space-y-3">
        {SOUND_CHANNEL_ROWS.map((row) => (
          <label
            key={row.channel}
            className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3"
          >
            <span className="shrink-0 text-sm text-muted">{row.label}</span>
            <select
              value={soundTypes[row.channel]}
              aria-label={row.ariaLabel}
              aria-describedby="notification-sound-help"
              onChange={(event) => changeSoundType(row.channel, event.target.value)}
              className="h-9 w-full max-w-[14rem] rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong"
            >
              {SOUND_TYPES.map((type) => (
                <option key={type} value={type}>
                  {notificationSoundTypeLabel(type)}
                </option>
              ))}
            </select>
          </label>
        ))}

        <label className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="shrink-0 text-sm text-muted">音量（共通）</span>
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <input
              id="notification-sound-volume"
              type="range"
              min={0}
              max={MAX_NOTIFICATION_SOUND_VOLUME}
              step={1}
              value={volume}
              aria-label="通知音の音量"
              aria-valuetext={`${volume}%`}
              aria-describedby="notification-sound-help"
              onChange={(event) => changeVolume(event.target.value)}
              className="min-w-0 flex-1 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
            <output
              htmlFor="notification-sound-volume"
              className="w-12 shrink-0 text-right font-mono text-sm text-text"
            >
              {volume}%
            </output>
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={volume === 0}
          onClick={() => playSessionCompleteSound("code")}
        >
          Code完了音
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={volume === 0}
          onClick={() => playSessionCompleteSound("bot")}
        >
          Bot完了音
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={volume === 0}
          onClick={playAttentionRequiredSound}
        >
          注意音
        </Button>
      </div>
      <p id="notification-sound-help" className="mt-2.5 text-[11px] text-muted">
        変更は即座に反映され、自動で保存されます。音量が0%のときは通知音は鳴りません。
      </p>
    </div>
  );
}
