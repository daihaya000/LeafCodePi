"use client";

import { useCallback, useEffect, useState } from "react";
import { MobileMenuHeader } from "@/components/shell/MobileMenuHeader";
import { ProviderAuthPanel } from "@/components/settings/ProviderAuthPanel";
import { ProviderModelsPanel } from "@/components/settings/ProviderModelsPanel";
import { AutoModelSettings } from "@/components/settings/AutoModelSettings";
import { GenerationModelSettings } from "@/components/settings/GenerationModelSettings";
import { LlamaServerSettings } from "@/components/settings/LlamaServerSettings";
import { HostRestartPanel } from "@/components/settings/HostRestartPanel";
import { AgentsMdSettings } from "@/components/settings/AgentsMdSettings";
import { MemorySettings } from "@/components/settings/MemorySettings";
import { CompactionSettings } from "@/components/settings/CompactionSettings";
import { NavigatorSettings } from "@/components/settings/NavigatorSettings";
import { SkillsSettings } from "@/components/settings/SkillsSettings";
import { ExtensionsSettings } from "@/components/settings/ExtensionsSettings";
import { McpSettings } from "@/components/settings/McpSettings";
import { AgentsSettings } from "@/components/settings/AgentsSettings";
import { BrowserSettings } from "@/components/settings/BrowserSettings";
import { WebUiAuthSettings } from "@/components/settings/WebUiAuthSettings";
import { ReasoningTranslationSettings } from "@/components/settings/ReasoningTranslationSettings";
import { HangTimeoutSettings } from "@/components/settings/HangTimeoutSettings";
import { NotificationSoundSettings } from "@/components/settings/NotificationSoundSettings";
import { Badge, cx } from "@/components/ui";
import { getJson } from "@/lib/client";
import type { HealthDto, ProviderAuthDto } from "@/lib/types";

type Tab = "engine" | "models" | "agents" | "extensions";

// 廃止した「一般」カテゴリとエンジンサブタブの旧ハッシュを移行先へ届ける。
const MIGRATED_HASH_TAB: Readonly<Record<string, Tab>> = {
  "general-basic": "engine",
  "general-response": "engine",
  "general-agents": "agents",
  "general-integrations": "extensions",
  "engine-overview": "engine",
  "engine-basic": "engine",
  "engine-response": "engine",
};

function readHashTab(): Tab {
  if (typeof window === "undefined") return "engine";
  return MIGRATED_HASH_TAB[window.location.hash.replace(/^#/, "")] ?? "engine";
}

export function SettingsView() {
  const [tab, setTab] = useState<Tab>(readHashTab);

  const [health, setHealth] = useState<HealthDto | null>(null);
  const [providers, setProviders] = useState<ProviderAuthDto[]>([]);
  const [modelsRevision, setModelsRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void getJson<HealthDto>("/api/health")
      .then(setHealth)
      .catch(() => setError("ヘルスの取得に失敗しました"));
    void getJson<{ providers: ProviderAuthDto[] }>("/api/providers")
      .then((result) => setProviders(result.providers))
      .catch(() => undefined);
  }, []);

  const onProviderChanged = useCallback(() => {
    setModelsRevision((revision) => revision + 1);
    reload();
  }, [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const syncFromHash = () => {
      const key = window.location.hash.replace(/^#/, "");
      const migratedTab = MIGRATED_HASH_TAB[key];
      if (!migratedTab) return;
      setTab(migratedTab);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <MobileMenuHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6">
          <h1 className="text-xl font-semibold">設定</h1>
          <nav aria-label="設定" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1">
            {(
              [
                ["engine", "エンジン"],
                ["models", "モデル"],
                ["agents", "エージェント"],
                ["extensions", "拡張"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-label={`${label}タブ`}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => setTab(id)}
                className={cx(
                  "min-h-11 min-w-[5rem] flex-1 shrink-0 rounded-lg px-3 py-2 text-sm",
                  tab === id ? "bg-surface-2 font-medium text-text" : "text-muted hover:bg-surface-2 hover:text-text",
                )}
              >
                {label}
              </button>
            ))}
          </nav>

          {tab === "engine" && (
            <section className="space-y-4">
              <HostRestartPanel onRestarted={reload} />

              <div className="rounded-2xl border border-border bg-surface p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Pi Coding Agent</h2>
                  <Badge tone={health?.engineOk ? "success" : "warning"} pulse={!health?.engineOk}>
                    {health?.engineOk ? "利用可" : "未接続"}
                  </Badge>
                </div>
                <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
                  <dt className="text-muted">エンジン</dt>
                  <dd>Pi SDK（プロセス内埋め込み）</dd>
                  <dt className="text-muted">バージョン</dt>
                  <dd className="font-mono">{health?.version ?? "—"}</dd>
                  <dt className="text-muted">データ</dt>
                  <dd className="break-all font-mono text-xs">{health?.dataDir ?? "—"}</dd>
                  <dt className="text-muted">有効モデル数</dt>
                  <dd>{health?.modelCount ?? 0}</dd>
                </dl>
                {health?.error && <p className="mt-3 text-sm text-danger">{health.error}</p>}
                {error && <p className="mt-3 text-sm text-danger">{error}</p>}
              </div>

              <LlamaServerSettings />
              <BrowserSettings />
              <WebUiAuthSettings />
              <NotificationSoundSettings />
              <NavigatorSettings />
              <div className="rounded-2xl border border-border bg-surface p-4 text-sm text-muted">
                テーマはサイドバー右下のアイコンから切り替えます（ライト / ダーク / システム）。
              </div>
              <ReasoningTranslationSettings />
              <CompactionSettings />
              <HangTimeoutSettings />
            </section>
          )}

          {tab === "models" && (
            <section className="space-y-4">
              <div className="rounded-2xl border border-border bg-surface p-4">
                <ProviderModelsPanel refreshToken={modelsRevision} />
              </div>
              <AutoModelSettings refreshToken={modelsRevision} />
              <GenerationModelSettings refreshToken={modelsRevision} />
              <div className="rounded-2xl border border-border bg-surface p-4">
                <ProviderAuthPanel providers={providers} onChanged={onProviderChanged} />
              </div>
            </section>
          )}

          {tab === "agents" && (
            <section className="space-y-4">
              <AgentsMdSettings />
              <MemorySettings />
              <SkillsSettings />
              <AgentsSettings />
            </section>
          )}

          {tab === "extensions" && (
            <section className="space-y-4">
              <ExtensionsSettings />
              <McpSettings />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
