"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui";
import {
  clampTitleAutoUpdateFrequency,
  DEFAULT_TITLE_AUTO_UPDATE_ENABLED,
  DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY,
  hasStoredTitleAutoUpdateEnabled,
  hasStoredTitleAutoUpdateFrequency,
  MAX_TITLE_AUTO_UPDATE_FREQUENCY,
  MIN_TITLE_AUTO_UPDATE_FREQUENCY,
  parseTitleAutoUpdateEnabled,
  parseTitleAutoUpdateFrequency,
  readTitleAutoUpdateEnabled,
  readTitleAutoUpdateEnabledFromServer,
  readTitleAutoUpdateFrequency,
  readTitleAutoUpdateFrequencyFromServer,
  subscribeTitleAutoUpdateEnabled,
  subscribeTitleAutoUpdateFrequency,
  writeTitleAutoUpdateEnabled,
  writeTitleAutoUpdateEnabledToServer,
  writeTitleAutoUpdateFrequency,
  writeTitleAutoUpdateFrequencyToServer,
} from "@/lib/title-auto-update-settings";

export function TitleAutoUpdateSettings() {
  // SSRとの一致を保つため初期値は既定値固定とし、mount後に保存値へ切り替える。
  const [enabled, setEnabled] = useState(DEFAULT_TITLE_AUTO_UPDATE_ENABLED);
  const [frequency, setFrequency] = useState(DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY);
  const [draft, setDraft] = useState(String(DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const applyFrequency = (next: number) => {
      setFrequency(next);
      setDraft(String(next));
    };
    setEnabled(readTitleAutoUpdateEnabled());
    applyFrequency(readTitleAutoUpdateFrequency());
    const unsubscribeEnabled = subscribeTitleAutoUpdateEnabled(() => {
      setEnabled(readTitleAutoUpdateEnabled());
    });
    const unsubscribeFrequency = subscribeTitleAutoUpdateFrequency(() => {
      applyFrequency(readTitleAutoUpdateFrequency());
    });
    let active = true;
    void readTitleAutoUpdateEnabledFromServer().then((serverValue) => {
      if (!active) return;
      const next = hasStoredTitleAutoUpdateEnabled()
        ? readTitleAutoUpdateEnabled()
        : parseTitleAutoUpdateEnabled(serverValue);
      if (next !== readTitleAutoUpdateEnabled()) writeTitleAutoUpdateEnabled(next);
      setEnabled(next);
    });
    void readTitleAutoUpdateFrequencyFromServer().then((serverValue) => {
      if (!active) return;
      const next = hasStoredTitleAutoUpdateFrequency()
        ? readTitleAutoUpdateFrequency()
        : parseTitleAutoUpdateFrequency(serverValue);
      if (next !== readTitleAutoUpdateFrequency()) writeTitleAutoUpdateFrequency(next);
      applyFrequency(next);
    });
    return () => {
      active = false;
      unsubscribeEnabled();
      unsubscribeFrequency();
    };
  }, []);

  function commitEnabled(next: boolean) {
    setEnabled(next);
    setError(null);
    writeTitleAutoUpdateEnabled(next);
    void writeTitleAutoUpdateEnabledToServer(next);
  }

  function commitFrequency() {
    if (draft.trim() === "") {
      setDraft(String(frequency));
      setError("1以上の整数を入力してください");
      return;
    }
    const value = Number(draft);
    if (!Number.isFinite(value)) {
      setDraft(String(frequency));
      setError("1以上の整数を入力してください");
      return;
    }
    const next = clampTitleAutoUpdateFrequency(value);
    setFrequency(next);
    setDraft(String(next));
    setError(null);
    writeTitleAutoUpdateFrequency(next);
    void writeTitleAutoUpdateFrequencyToServer(next);
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">タイトル自動更新</h3>
      <p className="mt-1 text-xs text-muted">
        新規・未設定タスクの自動更新の既定と、有効時の更新間隔を設定します。タスクヘッダーのスイッチで個別に上書きできます。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Switch
          checked={enabled}
          onChange={() => commitEnabled(!enabled)}
          label="タイトル自動更新の既定"
        />
        <span className="text-sm text-text" aria-live="polite">
          既定: {enabled ? "ON" : "OFF"}
        </span>
      </div>
      <label className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="shrink-0 text-sm text-muted">更新頻度</span>
        <input
          type="number"
          min={MIN_TITLE_AUTO_UPDATE_FREQUENCY}
          max={MAX_TITLE_AUTO_UPDATE_FREQUENCY}
          step={1}
          value={draft}
          aria-label="タイトル自動更新の頻度"
          aria-describedby="title-auto-update-frequency-help"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitFrequency}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-9 w-full max-w-[10rem] rounded-lg border border-border bg-bg px-3 font-mono text-sm text-text outline-none focus:border-border-strong"
        />
        <span className="text-xs text-muted">ターンごと</span>
      </label>
      <p id="title-auto-update-frequency-help" className="mt-2 text-[11px] text-muted">
        {MIN_TITLE_AUTO_UPDATE_FREQUENCY}〜{MAX_TITLE_AUTO_UPDATE_FREQUENCY}ターンの範囲で指定できます。既定の頻度は{DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY}ターンごとです。
      </p>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
