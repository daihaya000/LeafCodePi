"use client";

import { useEffect, useState } from "react";
import { getJson, sendJson } from "@/lib/client";
import {
  AUTO_ARCHIVE_DAYS_SETTING_KEY,
  AUTO_ARCHIVE_DAY_OPTIONS,
  DEFAULT_AUTO_ARCHIVE_DAYS,
  isAutoArchiveDaysOption,
  type AutoArchiveDaysOption,
} from "@/lib/auto-archive-settings";

const SETTINGS_PATH = `/api/settings/${AUTO_ARCHIVE_DAYS_SETTING_KEY}`;
const DEFAULT_OPTION = String(DEFAULT_AUTO_ARCHIVE_DAYS) as AutoArchiveDaysOption;

export function AutoArchiveSettings() {
  const [option, setOption] = useState<AutoArchiveDaysOption>(DEFAULT_OPTION);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getJson<{ value: string | null }>(SETTINGS_PATH)
      .then(({ value }) => {
        if (!active) return;
        if (value !== null && !isAutoArchiveDaysOption(value)) {
          setError("保存済みの自動アーカイブ設定が不正です");
          return;
        }
        setOption(value ?? DEFAULT_OPTION);
        setLoaded(true);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "設定の読み込みに失敗しました");
      });
    return () => { active = false; };
  }, []);

  async function changeOption(value: string) {
    if (!isAutoArchiveDaysOption(value)) return;
    const previous = option;
    setOption(value);
    setSaving(true);
    setError(null);
    try {
      await sendJson(SETTINGS_PATH, { value }, "PUT");
    } catch (cause) {
      setOption(previous);
      setError(cause instanceof Error ? cause.message : "設定の保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">古いセッションの自動アーカイブ</h3>
      <p className="mt-1 text-xs text-muted">
        最終更新から指定日数が過ぎた停止中のCodeセッションを自動でアーカイブします。ピン留め・開いているセッション・Bot/Roomは対象外。履歴から復元できます。
      </p>
      <label className="mt-3 flex flex-col gap-1.5 @xl:flex-row @xl:items-center @xl:gap-3">
        <span className="shrink-0 text-sm text-muted">保存期間</span>
        <select
          value={option}
          aria-label="古いセッションの自動アーカイブ設定"
          disabled={!loaded || saving}
          onChange={(event) => void changeOption(event.target.value)}
          className="h-9 w-full max-w-[14rem] rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong disabled:opacity-50"
        >
          {AUTO_ARCHIVE_DAY_OPTIONS.map((value) => (
            <option key={value} value={value}>{value === "off" ? "オフ" : `${value}日経過後`}</option>
          ))}
        </select>
      </label>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
