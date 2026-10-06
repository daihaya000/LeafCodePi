"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ModelSelect, modelOptionForValue } from "@/components/ModelSelect";
import { GenerationEffortSelect } from "@/components/settings/GenerationModelSettings";
import { JevSettingCard } from "@/components/settings/JevSettingCard";
import { Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { formatTokens } from "@/lib/context-usage";
import {
  COMPACTION_ACTION_SETTING_KEY,
  COMPACTION_BACKGROUND_SETTING_KEY,
  COMPACTION_BACKGROUND_THRESHOLD_SETTING_KEY,
  parseBackgroundCompactionThreshold,
  COMPACTION_MODEL_EFFORT_SETTING_KEY,
  COMPACTION_MODEL_SETTING_KEY,
  COMPACTION_THRESHOLD_SETTING_KEY,
  DEFAULT_COMPACTION_THRESHOLD,
  parseCacheWarmingMode,
  parseCompactionAction,
  parseCompactionThreshold,
  type CacheWarmingMode,
  type CompactionAction,
} from "@/lib/compaction-settings";
import type { CompactionSettingsDto, ModelOption, ThinkingLevel } from "@/lib/types";
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
  const [threshold, setThreshold] = useState(DEFAULT_COMPACTION_THRESHOLD);
  const [backgroundEnabled, setBackgroundEnabled] = useState(true);
  const [backgroundThreshold, setBackgroundThreshold] = useState(70);
  const [backgroundThresholdInput, setBackgroundThresholdInput] = useState("70");
  const [backgroundSaving, setBackgroundSaving] = useState(false);
  const [cacheWarmingMode, setCacheWarmingMode] = useState<CacheWarmingMode>("streaming");
  const [jevEnabled, setJevEnabled] = useState(false);
  const [jevThreshold, setJevThreshold] = useState(DEFAULT_JEV_COMPACTION_THRESHOLD);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [compactionModel, setCompactionModel] = useState("");
  const [compactionEffort, setCompactionEffort] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selectedModel = useMemo(
    () => modelOptionForValue(models, compactionModel),
    [compactionModel, models],
  );

  const reloadModel = useCallback(async () => {
    setModelsLoading(true);
    try {
      const [modelResult, valueResult, effortResult] = await Promise.all([
        getJson<{ models: ModelOption[] }>("/api/models"),
        getJson<{ value: string | null }>(`/api/settings/${COMPACTION_MODEL_SETTING_KEY}`),
        getJson<{ value: string | null }>(`/api/settings/${COMPACTION_MODEL_EFFORT_SETTING_KEY}`),
      ]);
      const nextModels = modelResult.models ?? [];
      setModels(nextModels);
      setCompactionModel(modelOptionForValue(nextModels, valueResult.value)?.value ?? "");
      setCompactionEffort(effortResult.value ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "コンパクションモデルの読み込みに失敗しました");
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => { void reloadModel(); }, [reloadModel]);

  const reload = useCallback(async () => {
    try {
      const [compaction, actionResult, thresholdResult, cacheWarmingResult, jevEnabledResult, jevThresholdResult, backgroundResult, backgroundThresholdResult] = await Promise.all([
        getJson<{ settings: CompactionSettingsDto }>("/api/compaction-settings"),
        getJson<{ value: string | null }>(`/api/settings/${COMPACTION_ACTION_SETTING_KEY}`),
        getJson<{ value: string | null }>(`/api/settings/${COMPACTION_THRESHOLD_SETTING_KEY}`),
        getJson<{ mode?: unknown }>("/api/cache-warming"),
        getJson<{ value: string | null }>(`/api/settings/${JEV_COMPACTION_ENABLED_SETTING_KEY}`),
        getJson<{ value: string | null }>(`/api/settings/${JEV_COMPACTION_THRESHOLD_SETTING_KEY}`),
        getJson<{ value: string | null }>(`/api/settings/${COMPACTION_BACKGROUND_SETTING_KEY}`),
        getJson<{ value: string | null }>(`/api/settings/${COMPACTION_BACKGROUND_THRESHOLD_SETTING_KEY}`),
      ]);
      setSettings(compaction.settings);
      setAction(parseCompactionAction(actionResult.value));
      setThreshold(parseCompactionThreshold(thresholdResult.value));
      setCacheWarmingMode(parseCacheWarmingMode(cacheWarmingResult.mode) ?? "streaming");
      setJevEnabled(isJevCompactionEnabled(jevEnabledResult.value));
      setJevThreshold(parseJevCompactionThreshold(jevThresholdResult.value));
      setBackgroundEnabled(backgroundResult.value !== "0");
      const start = parseBackgroundCompactionThreshold(backgroundThresholdResult.value);
      setBackgroundThreshold(start);
      setBackgroundThresholdInput(String(start));
    } catch (err) {
      setError(err instanceof Error ? err.message : "圧縮設定の読み込みに失敗しました");
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function save(key: string, value: string) {
    try {
      await sendJson(`/api/settings/${key}`, { value }, "PUT");
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "圧縮設定の保存に失敗しました");
      return false;
    }
  }

  async function changeBackgroundEnabled() {
    setBackgroundSaving(true);
    const next = !backgroundEnabled;
    if (await save(COMPACTION_BACKGROUND_SETTING_KEY, next ? "1" : "0")) setBackgroundEnabled(next);
    setBackgroundSaving(false);
  }

  async function changeBackgroundThreshold() {
    const next = Number(backgroundThresholdInput);
    if (!Number.isInteger(next) || next < 50 || next > 85) {
      setBackgroundThresholdInput(String(backgroundThreshold));
      setError("先行生成の開始閾値は50〜85%の整数で指定してください");
      return;
    }
    if (next === backgroundThreshold) return;
    setBackgroundSaving(true);
    if (await save(COMPACTION_BACKGROUND_THRESHOLD_SETTING_KEY, String(next))) setBackgroundThreshold(next);
    else setBackgroundThresholdInput(String(backgroundThreshold));
    setBackgroundSaving(false);
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

  function changeCompactionModel(value: string) {
    setCompactionModel(value);
    void save(COMPACTION_MODEL_SETTING_KEY, value);
    const levels = modelOptionForValue(models, value)?.thinkingLevels ?? [];
    if (compactionEffort && !levels.includes(compactionEffort as ThinkingLevel)) {
      setCompactionEffort("");
      void save(COMPACTION_MODEL_EFFORT_SETTING_KEY, "");
    }
  }

  function changeCompactionEffort(value: string) {
    setCompactionEffort(value);
    void save(COMPACTION_MODEL_EFFORT_SETTING_KEY, value);
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
      <div className="mt-4 grid gap-3 @xl:grid-cols-2">
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
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              onBlur={() => void save(COMPACTION_THRESHOLD_SETTING_KEY, String(threshold))}
            />
            <span className="shrink-0 text-sm text-muted">%</span>
          </span>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">
        {action === "auto" ? `自動圧縮の設定閾値は${threshold}%です（70〜95%）。` : `使用率が${threshold}%に達したら設定した動作を実行します（70〜95%）。`}
      </p>
      {action === "auto" && (
        <p className="mt-1 text-xs text-muted">
          自動圧縮は安全余白を最低10%確保するため、指定閾値より早く最大90%相当で動く場合があります。
        </p>
      )}
      <div className="mt-4 border-t border-border pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold">圧縮要約の先行生成</h4>
            <p className="mt-1 text-xs text-muted">
              要約を裏で準備し、反映は既存の圧縮閾値まで待ちます。準備だけでは履歴やキャッシュを変更しません。
            </p>
          </div>
          <Switch checked={backgroundEnabled} onChange={() => void changeBackgroundEnabled()}
            label={`圧縮要約の先行生成を${backgroundEnabled ? "無効化" : "有効化"}`}
            disabled={action !== "auto"} busy={backgroundSaving} />
        </div>
        {backgroundEnabled && (
          <div className="mt-3">
            <label htmlFor="compaction-background-threshold" className="mb-1.5 block text-sm text-muted">先行生成の開始閾値</label>
            <span className="flex min-w-0 items-center gap-2">
              <input id="compaction-background-threshold" type="number" min={50} max={85} step={1}
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong disabled:opacity-40"
                value={backgroundThresholdInput} disabled={action !== "auto" || backgroundSaving}
                onChange={(event) => setBackgroundThresholdInput(event.target.value)}
                onBlur={() => void changeBackgroundThreshold()} />
              <span className="shrink-0 text-sm text-muted">%</span>
            </span>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">
          自動圧縮でのみ有効です。手動圧縮・Goal Loopには適用しません。開始は実効圧縮閾値の5ポイント手前までに調整されます。
          未採用の要約にもAPI利用料が発生する場合があります。
        </p>
      </div>
      <div className="mt-4 border-t border-border pt-4">
        <h4 className="text-sm font-semibold">コンパクションモデル</h4>
        <p className="mt-1 text-xs text-muted">
          圧縮時の要約に使うモデルです。未設定時、または要約に失敗したときはセッションのモデルを使います。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ModelSelect
            value={compactionModel}
            options={models}
            disabled={modelsLoading}
            loading={modelsLoading}
            onChange={changeCompactionModel}
            ariaLabel="コンパクションモデル"
            className="min-w-0 w-full @xl:w-auto @xl:flex-1 @xl:min-w-64"
            title={selectedModel?.label ?? "コンパクションモデルを選択"}
          />
          {compactionModel && (
            <GenerationEffortSelect
              label="コンパクションモデルのEffort"
              levels={selectedModel?.thinkingLevels ?? []}
              value={compactionEffort}
              disabled={modelsLoading}
              onChange={changeCompactionEffort}
            />
          )}
          {compactionModel && (
            <Button variant="ghost" size="sm" disabled={modelsLoading} onClick={() => changeCompactionModel("")}>
              クリア
            </Button>
          )}
        </div>
      </div>
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
