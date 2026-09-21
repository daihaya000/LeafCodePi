"use client";

import { useEffect, useRef, useState } from "react";
import { AutoRouteOverridesEditor } from "@/components/settings/AutoRouteOverridesEditor";
import { JevSettingCard } from "@/components/settings/JevSettingCard";
import { Switch, cx } from "@/components/ui";
import { getJson } from "@/lib/client";
import {
  AUTO_JEV_ENABLED_SETTING_KEY,
  AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY,
  AUTO_MODEL_ENABLED_SETTING_KEY,
  AUTO_OPTIMIZE_SETTING_KEY,
  AUTO_ROUTE_OVERRIDES_SETTING_KEY,
  hasStoredAutoSetting,
  readAutoJevEnabled,
  readAutoJevMinConfidence,
  readAutoModelEnabled,
  readAutoOptimizeMode,
  readAutoRouteConfig,
  readAutoSettingsFromServer,
  subscribeAutoSetting,
  writeAutoJevEnabled,
  writeAutoJevMinConfidence,
  writeAutoModelEnabled,
  writeAutoOptimizeMode,
  writeAutoRouteConfig,
  writeAutoSettingToServer,
} from "@/lib/auto-settings";
import {
  AUTO_OPTIMIZE_MODES,
  autoOptimizeModeLabel,
  isAutoRouteConfigEmpty,
  type AutoOptimizeMode,
  type AutoRouteConfig,
} from "@/lib/auto-model";
import type { ModelOption } from "@/lib/types";

export function AutoModelSettings({ refreshToken = 0 }: { refreshToken?: number }) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modelEnabled, setModelEnabled] = useState(() => readAutoModelEnabled());
  const [mode, setMode] = useState<AutoOptimizeMode>(() => readAutoOptimizeMode());
  const [routeConfig, setRouteConfig] = useState<AutoRouteConfig>(() => readAutoRouteConfig());
  const [jevEnabled, setJevEnabled] = useState(() => readAutoJevEnabled());
  const [jevMinConfidence, setJevMinConfidence] = useState(() => readAutoJevMinConfidence());
  const touchedRef = useRef({ modelEnabled: false, mode: false, routeConfig: false, jev: false });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getJson<{ models: ModelOption[] }>("/api/models")
      .then((result) => {
        if (active) setModels(result.models ?? []);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "モデル一覧を取得できません");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshToken]);

  useEffect(() => {
    const onModelEnabled = () => {
      touchedRef.current.modelEnabled = true;
      setModelEnabled(readAutoModelEnabled());
    };
    const onMode = () => {
      touchedRef.current.mode = true;
      setMode(readAutoOptimizeMode());
    };
    const onRouteConfig = () => {
      touchedRef.current.routeConfig = true;
      setRouteConfig(readAutoRouteConfig());
    };
    const onJev = () => {
      touchedRef.current.jev = true;
      setJevEnabled(readAutoJevEnabled());
      setJevMinConfidence(readAutoJevMinConfidence());
    };
    const unsubscribeModelEnabled = subscribeAutoSetting(AUTO_MODEL_ENABLED_SETTING_KEY, onModelEnabled);
    const unsubscribeMode = subscribeAutoSetting(AUTO_OPTIMIZE_SETTING_KEY, onMode);
    const unsubscribeRouteConfig = subscribeAutoSetting(AUTO_ROUTE_OVERRIDES_SETTING_KEY, onRouteConfig);
    const unsubscribeJevEnabled = subscribeAutoSetting(AUTO_JEV_ENABLED_SETTING_KEY, onJev);
    const unsubscribeJevConfidence = subscribeAutoSetting(AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY, onJev);
    return () => {
      unsubscribeModelEnabled();
      unsubscribeMode();
      unsubscribeRouteConfig();
      unsubscribeJevEnabled();
      unsubscribeJevConfidence();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void readAutoSettingsFromServer().then((snapshot) => {
      if (!active) return;
      if (
        snapshot.modelEnabled !== undefined &&
        !touchedRef.current.modelEnabled &&
        !hasStoredAutoSetting(AUTO_MODEL_ENABLED_SETTING_KEY)
      ) {
        writeAutoModelEnabled(snapshot.modelEnabled);
        setModelEnabled(snapshot.modelEnabled);
      }
      if (
        snapshot.mode &&
        !touchedRef.current.mode &&
        !hasStoredAutoSetting(AUTO_OPTIMIZE_SETTING_KEY)
      ) {
        writeAutoOptimizeMode(snapshot.mode);
        setMode(snapshot.mode);
      }
      if (
        snapshot.routeConfig &&
        !touchedRef.current.routeConfig &&
        !hasStoredAutoSetting(AUTO_ROUTE_OVERRIDES_SETTING_KEY)
      ) {
        writeAutoRouteConfig(snapshot.routeConfig);
        setRouteConfig(snapshot.routeConfig);
      }
      if (
        snapshot.jevEnabled !== undefined &&
        !touchedRef.current.jev &&
        !hasStoredAutoSetting(AUTO_JEV_ENABLED_SETTING_KEY)
      ) {
        writeAutoJevEnabled(snapshot.jevEnabled);
        setJevEnabled(snapshot.jevEnabled);
      }
      if (
        snapshot.jevMinConfidence !== undefined &&
        !touchedRef.current.jev &&
        !hasStoredAutoSetting(AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY)
      ) {
        writeAutoJevMinConfidence(snapshot.jevMinConfidence);
        setJevMinConfidence(snapshot.jevMinConfidence);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const changeModelEnabled = (next: boolean) => {
    touchedRef.current.modelEnabled = true;
    setModelEnabled(next);
    writeAutoModelEnabled(next);
    void writeAutoSettingToServer(AUTO_MODEL_ENABLED_SETTING_KEY, next ? "1" : "0");
  };

  const changeMode = (next: AutoOptimizeMode) => {
    touchedRef.current.mode = true;
    setMode(next);
    writeAutoOptimizeMode(next);
    void writeAutoSettingToServer(AUTO_OPTIMIZE_SETTING_KEY, next);
  };

  const changeRouteConfig = (next: AutoRouteConfig) => {
    touchedRef.current.routeConfig = true;
    setRouteConfig(next);
    writeAutoRouteConfig(next);
    void writeAutoSettingToServer(
      AUTO_ROUTE_OVERRIDES_SETTING_KEY,
      isAutoRouteConfigEmpty(next) ? "" : JSON.stringify(next),
    );
  };

  const changeJevEnabled = (next: boolean) => {
    touchedRef.current.jev = true;
    setJevEnabled(next);
    writeAutoJevEnabled(next);
    void writeAutoSettingToServer(AUTO_JEV_ENABLED_SETTING_KEY, next ? "1" : null);
  };

  const changeJevMinConfidence = (next: number) => {
    touchedRef.current.jev = true;
    setJevMinConfidence(next);
    writeAutoJevMinConfidence(next);
    void writeAutoSettingToServer(AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY, String(next));
  };

  return (
    <section aria-labelledby="auto-mode-heading" className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="auto-mode-heading" className="text-sm font-semibold">Autoモデル</h3>
          <p className="mt-1 text-xs text-muted">
            Autoはタスクごとにモデルを選びます。無効にするとモデル選択からAutoを外します。
          </p>
        </div>
        <Switch
          checked={modelEnabled}
          onChange={() => changeModelEnabled(!modelEnabled)}
          label={`Autoモデルを${modelEnabled ? "無効化" : "有効化"}`}
          title="Autoモデルの使用を切り替え"
        />
      </div>
      <div className="mt-3 space-y-3">
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <p className="text-xs font-medium text-text">最適化方針</p>
          <p className="mt-0.5 text-xs text-muted">コスト、品質、バランスの優先度を選びます。</p>
          <div
            role="group"
            aria-label="最適化方針"
            className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-surface-3 p-1"
          >
            {AUTO_OPTIMIZE_MODES.map((candidateMode) => (
              <button
                key={candidateMode}
                type="button"
                aria-pressed={mode === candidateMode}
                onClick={() => changeMode(candidateMode)}
                className={cx(
                  "min-h-11 rounded-md px-2 py-2 text-xs font-medium transition-colors",
                  mode === candidateMode
                    ? "bg-primary text-primary-fg"
                    : "text-muted hover:bg-surface hover:text-text",
                )}
              >
                {autoOptimizeModeLabel(candidateMode)}
              </button>
            ))}
          </div>
        </div>
        <AutoRouteOverridesEditor mode={mode} models={models} config={routeConfig} onChange={changeRouteConfig} />
        <JevSettingCard
          title="Jevルーティング"
          description="モデル難易度とエージェント選択をJevに判断させます。無効時は従来のルールベースのままです。"
          enabled={jevEnabled}
          onEnabledChange={changeJevEnabled}
          enabledLabel={`Jevルーティングを${jevEnabled ? "無効化" : "有効化"}`}
          threshold={jevMinConfidence}
          thresholdLabel="最低信頼度"
          thresholdAriaLabel="Jevルーティングの最低信頼度"
          onThresholdChange={changeJevMinConfidence}
          thresholdHelp="未満は従来のルールへフォールバック"
        />
      </div>
      {loading && <p className="mt-2 text-xs text-muted">モデルを読み込み中…</p>}
      {models.length === 0 && !loading && <p className="mt-2 text-xs text-muted">利用可能なモデルがありません。</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
