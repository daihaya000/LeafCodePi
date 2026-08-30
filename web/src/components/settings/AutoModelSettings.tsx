"use client";

import { useEffect, useRef, useState } from "react";
import { AutoOptimizeSelect } from "@/components/AutoOptimizeSelect";
import { AutoRouteOverridesEditor } from "@/components/settings/AutoRouteOverridesEditor";
import { getJson } from "@/lib/client";
import {
  AUTO_OPTIMIZE_SETTING_KEY,
  AUTO_ROUTE_OVERRIDES_SETTING_KEY,
  AUTO_SHOW_MODEL_SETTING_KEY,
  hasStoredAutoSetting,
  readAutoOptimizeMode,
  readAutoRouteConfig,
  readAutoSettingsFromServer,
  readAutoShowModel,
  subscribeAutoSetting,
  writeAutoOptimizeMode,
  writeAutoRouteConfig,
  writeAutoSettingToServer,
  writeAutoShowModel,
} from "@/lib/auto-settings";
import { isAutoRouteConfigEmpty, type AutoOptimizeMode, type AutoRouteConfig } from "@/lib/auto-model";
import type { ModelOption } from "@/lib/types";

function SettingSwitch({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const label = "Autoが選んだモデル名を表示";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${label} ${enabled ? "無効化" : "有効化"}`}
      onClick={() => onChange(!enabled)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary ${enabled ? "bg-success" : "bg-surface-3"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform ${
          enabled ? "translate-x-5 bg-primary-fg" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export function AutoModelSettings({ refreshToken = 0 }: { refreshToken?: number }) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<AutoOptimizeMode>(() => readAutoOptimizeMode());
  const [showModel, setShowModel] = useState(() => readAutoShowModel());
  const [routeConfig, setRouteConfig] = useState<AutoRouteConfig>(() => readAutoRouteConfig());
  const touchedRef = useRef({ mode: false, showModel: false, routeConfig: false });

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
    const onMode = () => {
      touchedRef.current.mode = true;
      setMode(readAutoOptimizeMode());
    };
    const onShowModel = () => {
      touchedRef.current.showModel = true;
      setShowModel(readAutoShowModel());
    };
    const onRouteConfig = () => {
      touchedRef.current.routeConfig = true;
      setRouteConfig(readAutoRouteConfig());
    };
    const unsubscribeMode = subscribeAutoSetting(AUTO_OPTIMIZE_SETTING_KEY, onMode);
    const unsubscribeShowModel = subscribeAutoSetting(AUTO_SHOW_MODEL_SETTING_KEY, onShowModel);
    const unsubscribeRouteConfig = subscribeAutoSetting(AUTO_ROUTE_OVERRIDES_SETTING_KEY, onRouteConfig);
    return () => {
      unsubscribeMode();
      unsubscribeShowModel();
      unsubscribeRouteConfig();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void readAutoSettingsFromServer().then((snapshot) => {
      if (!active) return;
      if (
        snapshot.mode &&
        !touchedRef.current.mode &&
        !hasStoredAutoSetting(AUTO_OPTIMIZE_SETTING_KEY)
      ) {
        writeAutoOptimizeMode(snapshot.mode);
        setMode(snapshot.mode);
      }
      if (
        snapshot.showModel !== undefined &&
        !touchedRef.current.showModel &&
        !hasStoredAutoSetting(AUTO_SHOW_MODEL_SETTING_KEY)
      ) {
        writeAutoShowModel(snapshot.showModel);
        setShowModel(snapshot.showModel);
      }
      if (
        snapshot.routeConfig &&
        !touchedRef.current.routeConfig &&
        !hasStoredAutoSetting(AUTO_ROUTE_OVERRIDES_SETTING_KEY)
      ) {
        writeAutoRouteConfig(snapshot.routeConfig);
        setRouteConfig(snapshot.routeConfig);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const changeMode = (next: AutoOptimizeMode) => {
    touchedRef.current.mode = true;
    setMode(next);
    writeAutoOptimizeMode(next);
    void writeAutoSettingToServer(AUTO_OPTIMIZE_SETTING_KEY, next);
  };

  const changeShowModel = (next: boolean) => {
    touchedRef.current.showModel = true;
    setShowModel(next);
    writeAutoShowModel(next);
    void writeAutoSettingToServer(AUTO_SHOW_MODEL_SETTING_KEY, next ? "1" : "");
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

  return (
    <section aria-labelledby="auto-mode-heading" className="rounded-2xl border border-border bg-surface p-4">
      <h2 id="auto-mode-heading" className="text-sm font-semibold">Auto モード</h2>
      <p className="mt-1 text-xs text-muted">
        Autoはタスクごとにモデルを選びます。最適化方針はcomposerのeffort欄からも変更できます。
      </p>
      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2">
          <div>
            <p className="text-xs font-medium text-text">最適化方針</p>
            <p className="mt-0.5 text-xs text-muted">コスト、品質、バランスの優先度を選びます。</p>
          </div>
          <AutoOptimizeSelect value={mode} onChange={changeMode} />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2">
          <div>
            <p className="text-xs font-medium text-text">Autoが選んだモデルを表示</p>
            <p className="mt-0.5 text-xs text-muted">既定では非表示です。モデル名ではなく結果で判断できます。</p>
          </div>
          <SettingSwitch enabled={showModel} onChange={changeShowModel} />
        </div>
        <AutoRouteOverridesEditor mode={mode} models={models} config={routeConfig} onChange={changeRouteConfig} />
      </div>
      {loading && <p className="mt-2 text-xs text-muted">モデルを読み込み中…</p>}
      {models.length === 0 && !loading && <p className="mt-2 text-xs text-muted">利用可能なモデルがありません。</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
