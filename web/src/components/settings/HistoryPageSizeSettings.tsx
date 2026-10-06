"use client";

import { useEffect, useState } from "react";
import { getJson, sendJson } from "@/lib/client";
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  HISTORY_PAGE_SIZE_OPTIONS,
  HISTORY_PAGE_SIZE_SETTING_KEY,
  parseHistoryPageSize,
} from "@/lib/history-page-size";

const SETTINGS_PATH = `/api/settings/${HISTORY_PAGE_SIZE_SETTING_KEY}`;

/** 履歴の初回表示と「過去の履歴を読み込む」で1回に取得するメッセージ数（サーバ保存）。 */
export function HistoryPageSizeSettings() {
  const [size, setSize] = useState(DEFAULT_HISTORY_PAGE_SIZE);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getJson<{ value: string | null }>(SETTINGS_PATH)
      .then(({ value }) => {
        if (!active) return;
        setSize(parseHistoryPageSize(value));
        setLoaded(true);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "設定の読み込みに失敗しました");
      });
    return () => { active = false; };
  }, []);

  async function changeSize(raw: string) {
    const next = Number(raw);
    if (!HISTORY_PAGE_SIZE_OPTIONS.some((option) => option === next)) return;
    const previous = size;
    setSize(next);
    setSaving(true);
    setError(null);
    try {
      await sendJson(SETTINGS_PATH, { value: String(next) }, "PUT");
    } catch (cause) {
      setSize(previous);
      setError(cause instanceof Error ? cause.message : "設定の保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  // 保存済みの値が選択肢にない場合も、その値を表示して失わないようにする。
  const options = HISTORY_PAGE_SIZE_OPTIONS.some((option) => option === size)
    ? [...HISTORY_PAGE_SIZE_OPTIONS]
    : [...HISTORY_PAGE_SIZE_OPTIONS, size].sort((a, b) => a - b);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">履歴の読み込み件数</h3>
      <p className="mt-1 text-xs text-muted">
        タスク画面を開いたときと「過去の履歴を読み込む」を押したときに、1回で取得するメッセージ数です。
        増やすとさかのぼれる範囲が広がりますが、表示と通信が重くなります。ターン途中で切らないため、指定件数より多くなる場合があります。次回のページ読み込みから反映されます。
      </p>
      <label className="mt-3 flex flex-col gap-1.5 @xl:flex-row @xl:items-center @xl:gap-3">
        <span className="shrink-0 text-sm text-muted">1回の件数</span>
        <select
          value={size}
          aria-label="履歴の1回あたりの読み込み件数"
          disabled={!loaded || saving}
          onChange={(event) => void changeSize(event.target.value)}
          className="h-9 w-full max-w-[14rem] rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong disabled:opacity-50"
        >
          {options.map((value) => (
            <option key={value} value={value}>
              {value}件{value === DEFAULT_HISTORY_PAGE_SIZE ? "（既定）" : ""}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
