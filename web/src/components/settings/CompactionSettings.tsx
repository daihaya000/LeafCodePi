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
      <h3 className="text-sm font-semibold">コンテキスト節約</h3>
      <p className="mt-1 text-xs text-muted">
        コンテキスト使用量が閾値に達したときの動作を選択します。手動送信時の動作、Goal Loopには適用されません。
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label htmlFor="compaction-action" className="block">
          <span className="mb-1.5 block text-sm text-muted">動作</span>
          <select
            id="compaction-action"
            className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong"
            value={action}
            onChange={(e) => void changeAction(e.target.value as CompactionAction)}
          >
            <option value="suggest">提案</option>
            <option value="auto">自動圧縮</option>
            <option value="off">無効</option>
          </select>
        </label>
        <div>
          <label htmlFor="compaction-threshold" className="mb-1.5 block text-sm text-muted">
            コンテキスト使用率の閾値
          </label>
          <span className="flex min-w-0 items-center gap-2">
            <input
              id="compaction-threshold"
              type="number"
              min={70}
              max={95}
              step={1}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 font-mono text-sm text-text outline-none focus:border-border-strong"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              onBlur={() => void save(COMPACTION_THRESHOLD_SETTING_KEY, String(threshold))}
            />
            <span className="shrink-0 text-sm text-muted">%</span>
          </span>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">使用率が{threshold}%に達したらcompactを提案します（70〜95%）。</p>
      {settings && <p className="mt-2 text-[11px] text-muted">予約トークン {formatTokens(settings.reserveTokens)} / 直近保持 {formatTokens(settings.keepRecentTokens)}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
