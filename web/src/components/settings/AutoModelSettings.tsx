"use client";

import { useEffect, useRef, useState } from "react";
import { AutoOptimizeSelect } from "@/components/AutoOptimizeSelect";
import { AutoRouteOverridesEditor } from "@/components/settings/AutoRouteOverridesEditor";
import { getJson } from "@/lib/client";
import {
  AUTO_OPTIMIZE_SETTING_KEY,
  AUTO_ROUTE_OVERRIDES_SETTING_KEY,
  hasStoredAutoSetting,
  readAutoOptimizeMode,
  readAutoRouteConfig,
  readAutoSettingsFromServer,
  subscribeAutoSetting,
  writeAutoOptimizeMode,
  writeAutoRouteConfig,
  writeAutoSettingToServer,
} from "@/lib/auto-settings";
import { isAutoRouteConfigEmpty, type AutoOptimizeMode, type AutoRouteConfig } from "@/lib/auto-model";
import type { ModelOption } from "@/lib/types";

export function AutoModelSettings({ refreshToken = 0 }: { refreshToken?: number }) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<AutoOptimizeMode>(() => readAutoOptimizeMode());
  const [routeConfig, setRouteConfig] = useState<AutoRouteConfig>(() => readAutoRouteConfig());
  const touchedRef = useRef({ mode: false, routeConfig: false });

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
    const onRouteConfig = () => {
      touchedRef.current.routeConfig = true;
      setRouteConfig(readAutoRouteConfig());
    };
    const unsubscribeMode = subscribeAutoSetting(AUTO_OPTIMIZE_SETTING_KEY, onMode);
    const unsubscribeRouteConfig = subscribeAutoSetting(AUTO_ROUTE_OVERRIDES_SETTING_KEY, onRouteConfig);
    return () => {
      unsubscribeMode();
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
      <h3 id="auto-mode-heading" className="text-sm font-semibold">Autoモデル</h3>
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
        <AutoRouteOverridesEditor mode={mode} models={models} config={routeConfig} onChange={changeRouteConfig} />
      </div>
      {loading && <p className="mt-2 text-xs text-muted">モデルを読み込み中…</p>}
      {models.length === 0 && !loading && <p className="mt-2 text-xs text-muted">利用可能なモデルがありません。</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
