"use client";

import { useEffect, useState } from "react";
import {
  clampTitleAutoUpdateFrequency,
  DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY,
  hasStoredTitleAutoUpdateFrequency,
  MAX_TITLE_AUTO_UPDATE_FREQUENCY,
  MIN_TITLE_AUTO_UPDATE_FREQUENCY,
  parseTitleAutoUpdateFrequency,
  readTitleAutoUpdateFrequency,
  readTitleAutoUpdateFrequencyFromServer,
  subscribeTitleAutoUpdateFrequency,
  writeTitleAutoUpdateFrequency,
  writeTitleAutoUpdateFrequencyToServer,
} from "@/lib/title-auto-update-settings";

export function TitleAutoUpdateSettings() {
  // SSRとの一致を保つため初期値は既定値固定とし、mount後に保存値へ切り替える。
  const [frequency, setFrequency] = useState(DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY);
  const [draft, setDraft] = useState(String(DEFAULT_TITLE_AUTO_UPDATE_FREQUENCY));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const apply = (next: number) => {
      setFrequency(next);
      setDraft(String(next));
    };
    apply(readTitleAutoUpdateFrequency());
    const unsubscribe = subscribeTitleAutoUpdateFrequency(() => {
      apply(readTitleAutoUpdateFrequency());
    });
    let active = true;
    void readTitleAutoUpdateFrequencyFromServer().then((serverValue) => {
      if (!active) return;
      // localStorage is the immediate copy and wins when it already exists;
      // otherwise restore the durable server backup for a new browser.
      const next = hasStoredTitleAutoUpdateFrequency()
        ? readTitleAutoUpdateFrequency()
        : parseTitleAutoUpdateFrequency(serverValue);
      if (next !== readTitleAutoUpdateFrequency()) writeTitleAutoUpdateFrequency(next);
      apply(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  function commit() {
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
        タスクごとの自動更新が有効なとき、会話のタイトルを更新する間隔を設定します。既定は5ターンごとです。
      </p>
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
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-9 w-full max-w-[10rem] rounded-lg border border-border bg-bg px-3 font-mono text-sm text-text outline-none focus:border-border-strong"
        />
        <span className="text-xs text-muted">ターンごと</span>
      </label>
      <p id="title-auto-update-frequency-help" className="mt-2 text-[11px] text-muted">
        {MIN_TITLE_AUTO_UPDATE_FREQUENCY}〜{MAX_TITLE_AUTO_UPDATE_FREQUENCY}ターンの範囲で指定できます。タスクヘッダーのスイッチで自動更新自体を停止できます。
      </p>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
