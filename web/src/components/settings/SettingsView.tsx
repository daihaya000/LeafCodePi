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
type EngineSection = "overview" | "basic" | "response";

const ENGINE_SECTIONS: readonly {
  id: EngineSection;
  label: string;
  description: string;
}[] = [
  { id: "overview", label: "エンジン", description: "Pi Coding Agent の状態とサーバー設定" },
  { id: "basic", label: "基本", description: "表示・通知に関する設定" },
  { id: "response", label: "応答", description: "翻訳・圧縮・自動再開に関する設定" },
];

function isEngineSection(value: string): value is EngineSection {
  return ENGINE_SECTIONS.some((section) => section.id === value);
}

// 旧「設定 > 一般」メニューのハッシュ。廃止後もブックマークや外部リンクから
// 移行先タブへ届けるための互換マッピング。
const LEGACY_HASH_TAB: Readonly<Record<string, Tab>> = {
  "general-agents": "agents",
  "general-integrations": "extensions",
};
const LEGACY_HASH_ENGINE_SECTION: Readonly<Record<string, EngineSection>> = {
  "general-basic": "basic",
  "general-response": "response",
};

function isSettingsHashKey(key: string): boolean {
  return key.startsWith("engine-") || key in LEGACY_HASH_TAB || key in LEGACY_HASH_ENGINE_SECTION;
}

function resolveHashState(hash: string): { tab: Tab; engineSection: EngineSection } {
  const key = hash.replace(/^#/, "");
  if (key.startsWith("engine-")) {
    const section = key.replace(/^engine-/, "");
    return { tab: "engine", engineSection: isEngineSection(section) ? section : "overview" };
  }
  const legacyEngineSection = LEGACY_HASH_ENGINE_SECTION[key];
  if (legacyEngineSection) return { tab: "engine", engineSection: legacyEngineSection };
  const legacyTab = LEGACY_HASH_TAB[key];
  if (legacyTab) return { tab: legacyTab, engineSection: "overview" };
  return { tab: "engine", engineSection: "overview" };
}

function readInitialHashState(): { tab: Tab; engineSection: EngineSection } {
  if (typeof window === "undefined") return { tab: "engine", engineSection: "overview" };
  return resolveHashState(window.location.hash);
}

export function SettingsView() {
  const [tab, setTab] = useState<Tab>(() => readInitialHashState().tab);
  const [engineSection, setEngineSection] = useState<EngineSection>(() => readInitialHashState().engineSection);

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
      // 設定以外のハッシュ変更（他機能のリンク移動等）で engineSection を
      // 黙ってリセットしないようにガードする。
      if (!isSettingsHashKey(key)) return;
      const resolved = resolveHashState(window.location.hash);
      setTab(resolved.tab);
      setEngineSection(resolved.engineSection);
      // 旧ハッシュは新形式に正規化しておく（ブックマーク・共有は旧形式のままになり䷄ける）。
      if (key in LEGACY_HASH_TAB || key in LEGACY_HASH_ENGINE_SECTION) {
        const canonicalHash = resolved.tab === "engine" ? `#engine-${resolved.engineSection}` : "";
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${canonicalHash}`);
      }
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, []);

  function selectEngineSection(section: EngineSection) {
    setEngineSection(section);
    if (typeof window !== "undefined") {
      const hash = `#engine-${section}`;
      if (window.location.hash !== hash) window.location.hash = hash;
    }
  }

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
            <div className="grid gap-6 md:grid-cols-[12rem_minmax(0,1fr)] md:items-start">
              <nav aria-label="エンジン設定" className="min-w-0 md:sticky md:top-6">
                <p className="mb-2 px-2 text-xs font-semibold text-muted">エンジン</p>
                <div className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
                  {ENGINE_SECTIONS.map(({ id, label }) => (
                    <button
                      key={id}
                      type="button"
                      aria-current={engineSection === id ? "page" : undefined}
                      onClick={() => selectEngineSection(id)}
                      className={cx(
                        "min-h-11 shrink-0 rounded-lg border-b-2 px-3 py-2 text-left text-sm whitespace-nowrap transition-colors md:w-full md:border-b-0 md:border-l-2",
                        engineSection === id
                          ? "border-accent bg-surface-2 font-medium text-text"
                          : "border-transparent text-muted hover:bg-surface-2 hover:text-text",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </nav>

              <div className="min-w-0">
                {ENGINE_SECTIONS.map(({ id, label, description }) => engineSection === id && (
                  <section
                    key={id}
                    aria-labelledby={`engine-${id}-heading`}
                    className="space-y-4"
                  >
                    <header>
                      <h2 id={`engine-${id}-heading`} className="text-lg font-semibold">
                        {label}
                      </h2>
                      <p className="mt-1 text-sm text-muted">{description}</p>
                    </header>

                    {id === "overview" && (
                      <div className="space-y-4">
                        <HostRestartPanel onRestarted={reload} />

                        <div className="rounded-2xl border border-border bg-surface p-4">
                          <div className="mb-3 flex items-center justify-between">
                            <h3 className="text-sm font-semibold">Pi Coding Agent</h3>
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
                      </div>
                    )}
                    {id === "basic" && (
                      <div className="space-y-4">
                        <BrowserSettings />
                        <WebUiAuthSettings />
                        <NotificationSoundSettings />
                        <NavigatorSettings />
                        <div className="rounded-2xl border border-border bg-surface p-4 text-sm text-muted">
                          テーマはサイドバー右下のアイコンから切り替えます（ライト / ダーク / システム）。
                        </div>
                      </div>
                    )}
                    {id === "response" && (
                      <div className="space-y-4">
                        <ReasoningTranslationSettings />
                        <CompactionSettings />
                        <HangTimeoutSettings />
                      </div>
                    )}
                  </section>
                ))}
              </div>
            </div>
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
