"use client";

import { useCallback, useEffect, useState } from "react";
import { JevSettingCard } from "@/components/settings/JevSettingCard";
import { getJson, sendJson } from "@/lib/client";
import { formatTokens } from "@/lib/context-usage";
import {
  COMPACTION_ACTION_SETTING_KEY,
  COMPACTION_THRESHOLD_SETTING_KEY,
  parseCacheWarmingMode,
  parseCompactionAction,
  parseCompactionThreshold,
  type CacheWarmingMode,
  type CompactionAction,
} from "@/lib/compaction-settings";
import type { CompactionSettingsDto } from "@/lib/types";
import {
  DEFAULT_JEV_COMPACTION_THRESHOLD,
  isJevCompactionEnabled,
  JEV_COMPACTION_ENABLED_SETTING_KEY,
  JEV_COMPACTION_THRESHOLD_SETTING_KEY,
  parseJevCompactionThreshold,
} from "@/lib/jev-compaction-settings";

export function CompactionSettings() {
  const [settings, setSettings] = useState<CompactionSettingsDto | null>(null);
  const [action, setAction] = useState<CompactionAction>("auto");
  const [threshold, setThreshold] = useState(80);
  const [cacheWarmingMode, setCacheWarmingMode] = useState<CacheWarmingMode>("streaming");
  const [jevEnabled, setJevEnabled] = useState(false);
  const [jevThreshold, setJevThreshold] = useState(DEFAULT_JEV_COMPACTION_THRESHOLD);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [compaction, actionResult, thresholdResult, cacheWarmingResult, jevEnabledResult, jevThresholdResult] = await Promise.all([
        getJson<{ settings: CompactionSettingsDto }>("/api/compaction-settings"),
        getJson<{ value: string | null }>(`/api/settings/${COMPACTION_ACTION_SETTING_KEY}`),
        getJson<{ value: string | null }>(`/api/settings/${COMPACTION_THRESHOLD_SETTING_KEY}`),
        getJson<{ mode?: unknown }>("/api/cache-warming"),
        getJson<{ value: string | null }>(`/api/settings/${JEV_COMPACTION_ENABLED_SETTING_KEY}`),
        getJson<{ value: string | null }>(`/api/settings/${JEV_COMPACTION_THRESHOLD_SETTING_KEY}`),
      ]);
      setSettings(compaction.settings);
      setAction(parseCompactionAction(actionResult.value));
      setThreshold(parseCompactionThreshold(thresholdResult.value));
      setCacheWarmingMode(parseCacheWarmingMode(cacheWarmingResult.mode) ?? "streaming");
      setJevEnabled(isJevCompactionEnabled(jevEnabledResult.value));
      setJevThreshold(parseJevCompactionThreshold(jevThresholdResult.value));
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

  async function changeCacheWarmingMode(value: CacheWarmingMode) {
    setCacheWarmingMode(value);
    try {
      const result = await sendJson<{ mode?: unknown }>(
        "/api/cache-warming", { mode: value }, "PATCH",
      );
      setCacheWarmingMode(parseCacheWarmingMode(result.mode) ?? value);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "プロンプトキャッシュ設定の保存に失敗しました");
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
      <p className="mt-3 text-xs text-muted">使用率が{threshold}%に達したら設定した動作を実行します（70〜95%）。</p>
      <div className="mt-4 border-t border-border pt-4">
        <h4 className="text-sm font-semibold">プロンプトキャッシュ維持</h4>
        <p className="mt-1 text-xs text-muted">
          対応モデルのキャッシュを維持します。待機中の維持はAPI利用料が発生する場合があります。
        </p>
        <label htmlFor="cache-warming-mode" className="mt-3 block">
          <span className="mb-1.5 block text-sm text-muted">維持モード</span>
          <select
            id="cache-warming-mode"
            className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong"
            value={cacheWarmingMode}
            onChange={(e) => void changeCacheWarmingMode(e.target.value as CacheWarmingMode)}
          >
            <option value="off">無効</option>
            <option value="streaming">実行中のみ</option>
            <option value="idle">待機中も維持</option>
          </select>
        </label>
      </div>
      <div className="mt-4 border-t border-border pt-4">
        <JevSettingCard
          title="Jevコンパクション"
          description="ツール結果をJevで選別し、不要な結果を要約せずに圧縮します。無効時は従来の要約を使います。"
          enabled={jevEnabled}
          onEnabledChange={(enabled) => {
            setJevEnabled(enabled);
            void save(JEV_COMPACTION_ENABLED_SETTING_KEY, enabled ? "1" : "");
          }}
          enabledLabel={`Jevコンパクションを${jevEnabled ? "無効化" : "有効化"}`}
          threshold={jevThreshold}
          thresholdLabel="残す確率"
          thresholdAriaLabel="Jevコンパクションの残す確率"
          onThresholdChange={(threshold) => {
            setJevThreshold(threshold);
            void save(JEV_COMPACTION_THRESHOLD_SETTING_KEY, String(threshold));
          }}
          thresholdHelp="未満のツール結果を省略"
        />
      </div>
      {settings && <p className="mt-2 text-[11px] text-muted">予約トークン {formatTokens(settings.reserveTokens)} / 直近保持 {formatTokens(settings.keepRecentTokens)}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
