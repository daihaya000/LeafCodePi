"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, sendJson } from "@/lib/client";

export type ConfigProvider = {
  id: string;
  name: string;
  enabled: boolean;
  configurable: boolean;
};

type ProviderSettings = {
  providers: ConfigProvider[];
  version: string;
};

/**
 * CodexBar のプロバイダー設定パネルを管理するフック。
 * 設定の読み込み・プロバイダーの有効/無効切替・パネル開閉状態を持つ。
 */
export function useCodexProviders({
  refresh,
}: {
  refresh: (force?: boolean) => Promise<void>;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providerSettings, setProviderSettings] =
    useState<ProviderSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<string | null>(null);
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadProviderSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const data = await getJson<ProviderSettings>("/api/codexbar/providers");
      if (!mounted.current) return;
      setProviderSettings(data);
      setSettingsError(null);
      setSettingsStatus("プロバイダー設定を読み込みました");
    } catch (err) {
      if (!mounted.current) return;
      setSettingsError(
        err instanceof Error ? err.message : "設定の読み込みに失敗しました",
      );
    } finally {
      if (mounted.current) setSettingsLoading(false);
    }
  }, []);

  const toggleProviderEnabled = useCallback(
    async (provider: ConfigProvider) => {
      if (!providerSettings) return;
      const enabledCount = providerSettings.providers.filter(
        (item) => item.enabled,
      ).length;
      if (provider.enabled && enabledCount <= 1) {
        setSettingsError("少なくとも 1 つのプロバイダーを有効にしてください");
        return;
      }

      setSavingProviderId(provider.id);
      try {
        const updated = await sendJson<ProviderSettings>(
          "/api/codexbar/providers",
          {
            providerId: provider.id,
            enabled: !provider.enabled,
            version: providerSettings.version,
          },
          "PUT",
        );
        if (!mounted.current) return;
        setProviderSettings(updated);
        setSettingsError(null);
        setSettingsStatus("プロバイダー設定を保存しました");
        void refresh(true);
      } catch (err) {
        if (!mounted.current) return;
        setSettingsError(
          err instanceof Error ? err.message : "設定の保存に失敗しました",
        );
      } finally {
        if (mounted.current) setSavingProviderId(null);
      }
    },
    [providerSettings, refresh],
  );

  const toggleProviderSettings = useCallback(() => {
    setSettingsOpen((open) => {
      const next = !open;
      if (next && !providerSettings && !settingsLoading) {
        void loadProviderSettings();
      }
      return next;
    });
  }, [providerSettings, settingsLoading, loadProviderSettings]);

  return {
    settingsOpen,
    providerSettings,
    settingsLoading,
    settingsError,
    settingsStatus,
    savingProviderId,
    toggleProviderSettings,
    toggleProviderEnabled,
    loadProviderSettings,
  };
}
