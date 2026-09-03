import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import {
  clampNotificationSoundVolume,
  MAX_NOTIFICATION_SOUND_VOLUME,
  isNotificationSoundType,
  notificationSoundTypeLabel,
  readNotificationSoundType,
  readNotificationSoundVolume,
  subscribeNotificationSound,
  syncNotificationSoundToServer,
  writeNotificationSoundType,
  writeNotificationSoundVolume,
  type NotificationSoundType,
} from "@/lib/notification-sound-settings";
import {
  playAttentionRequiredSound,
  playSessionCompleteSound,
} from "@/lib/session-complete-sound";

const SERVER_SYNC_DELAY_MS = 400;

const SOUND_TYPES: NotificationSoundType[] = ["standard", "soft", "clear"];

export function NotificationSoundSettings() {
  const [soundType, setSoundType] = useState<NotificationSoundType>(() =>
    readNotificationSoundType(),
  );
  const [volume, setVolume] = useState(() => readNotificationSoundVolume());
  const latestRef = useRef({ soundType, volume });
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestRef.current = { soundType, volume };
  }, [soundType, volume]);

  useEffect(() => subscribeNotificationSound(() => {
    setSoundType(readNotificationSoundType());
    setVolume(readNotificationSoundVolume());
  }), []);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current !== null) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
        const latest = latestRef.current;
        void syncNotificationSoundToServer(latest.soundType, latest.volume);
      }
    };
  }, []);

  const scheduleServerSync = (next: {
    soundType: NotificationSoundType;
    volume: number;
  }) => {
    latestRef.current = next;
    if (syncTimerRef.current !== null) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      const latest = latestRef.current;
      void syncNotificationSoundToServer(latest.soundType, latest.volume);
    }, SERVER_SYNC_DELAY_MS);
  };

  const changeSoundType = (value: string) => {
    if (!isNotificationSoundType(value)) return;
    const next = { soundType: value, volume: latestRef.current.volume };
    setSoundType(value);
    writeNotificationSoundType(value);
    scheduleServerSync(next);
  };

  const changeVolume = (value: string) => {
    const nextVolume = clampNotificationSoundVolume(Number(value));
    const next = {
      soundType: latestRef.current.soundType,
      volume: nextVolume,
    };
    setVolume(nextVolume);
    writeNotificationSoundVolume(nextVolume);
    scheduleServerSync(next);
  };

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-muted">通知音</h2>
      <p className="mb-3 text-xs text-muted">
        タスク完了時と、許可・質問の表示時に鳴る音を設定します。
      </p>
      <div className="rounded-xl border border-border bg-surface px-4 py-3">
        <label className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="shrink-0 text-sm text-muted">通知音の種類</span>
          <select
            value={soundType}
            aria-label="通知音の種類"
            aria-describedby="notification-sound-help"
            onChange={(event) => changeSoundType(event.target.value)}
            className="h-9 w-full max-w-[14rem] rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong"
          >
            {SOUND_TYPES.map((type) => (
              <option key={type} value={type}>
                {notificationSoundTypeLabel(type)}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="shrink-0 text-sm text-muted">音量</span>
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

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={volume === 0}
            onClick={playSessionCompleteSound}
          >
            完了音を再生
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={volume === 0}
            onClick={playAttentionRequiredSound}
          >
            注意音を再生
          </Button>
        </div>
        <p id="notification-sound-help" className="mt-2.5 text-[11px] text-muted">
          変更は即座に反映され、自動で保存されます。音量が0%のときは通知音は鳴りません。
        </p>
      </div>
    </section>
  );
}
