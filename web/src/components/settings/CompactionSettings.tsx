"use client";

import { useCallback, useEffect, useState } from "react";
import { getJson, sendJson } from "@/lib/client";
import { formatTokens } from "@/lib/context-usage";
import {
  COMPACTION_ACTION_SETTING_KEY,
  COMPACTION_THRESHOLD_SETTING_KEY,
  parseCompactionAction,
  parseCompactionThreshold,
  type CompactionAction,
} from "@/lib/compaction-settings";
import type { CompactionSettingsDto } from "@/lib/types";

export function CompactionSettings() {
  const [settings, setSettings] = useState<CompactionSettingsDto | null>(null);
  const [action, setAction] = useState<CompactionAction>("suggest");
  const [threshold, setThreshold] = useState(80);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [compaction, actionResult, thresholdResult] = await Promise.all([
        getJson<{ settings: CompactionSettingsDto }>("/api/compaction-settings"),
        getJson<{ value: string | null }>(`/api/settings/${COMPACTION_ACTION_SETTING_KEY}`),
        getJson<{ value: string | null }>(`/api/settings/${COMPACTION_THRESHOLD_SETTING_KEY}`),
      ]);
      setSettings(compaction.settings);
      setAction(parseCompactionAction(actionResult.value));
      setThreshold(parseCompactionThreshold(thresholdResult.value));
    } catch (err) {
      setError(err instanceof Error ? err.message : "圧縮設定の読み込みに失敗しました");
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function save(key: string, value: string) {
    try {
      await sendJson(`/api/settings/${key}`, { value }, "PUT");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "圧縮設定の保存に失敗しました");
    }
  }

  async function changeAction(value: CompactionAction) {
    setAction(value);
    await save(COMPACTION_ACTION_SETTING_KEY, value);
    if (settings && settings.enabled !== (value === "auto")) {
      const result = await sendJson<{ settings: CompactionSettingsDto }>(
        "/api/compaction-settings", { enabled: value === "auto" }, "PATCH",
      );
      setSettings(result.settings);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold">コンテキスト節約</h2>
      <p className="mt-2 text-sm text-muted">コンテキスト使用量が閾値に達したときの動作を選択します。手動送信時の動作、Goal Loopには適用されません。</p>
      <div className="mt-4 flex items-center gap-4">
        <label htmlFor="compaction-action" className="text-sm text-muted">動作</label>
        <select id="compaction-action" className="h-14 w-84 rounded-xl border border-border bg-surface px-5 text-lg" value={action} onChange={(e) => void changeAction(e.target.value as CompactionAction)}>
          <option value="suggest">提案</option>
          <option value="auto">自動圧縮</option>
          <option value="off">無効</option>
        </select>
      </div>
      <div className="mt-4 flex items-center gap-4">
        <label htmlFor="compaction-threshold" className="text-sm text-muted">コンテキスト使用率の閾値</label>
        <input id="compaction-threshold" type="number" min={70} max={95} step={1} className="h-14 w-60 rounded-xl border border-border bg-surface px-5 text-lg" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} onBlur={() => void save(COMPACTION_THRESHOLD_SETTING_KEY, String(threshold))} />
        <span className="text-sm text-muted">%</span>
      </div>
      <p className="mt-3 text-xs text-faint">使用率が{threshold}%に達したらcompactを提案します（70〜95%）。</p>
      {settings && <p className="mt-2 text-[11px] text-faint">予約トークン {formatTokens(settings.reserveTokens)} / 直近保持 {formatTokens(settings.keepRecentTokens)}</p>}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
