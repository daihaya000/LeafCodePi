"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

const SETTINGS_TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "engine", label: "エンジン" },
  { id: "models", label: "モデル" },
  { id: "agents", label: "エージェント" },
  { id: "extensions", label: "拡張" },
];

const TAB_HASH: Readonly<Record<Tab, string>> = {
  engine: "engine",
  models: "models",
  agents: "agents",
  extensions: "extensions",
};

const CURRENT_HASH_TAB: Readonly<Record<string, Tab>> = {
  engine: "engine",
  models: "models",
  "models-catalog": "models",
  "models-local": "models",
  "models-auto": "models",
  "models-generation": "models",
  "models-providers": "models",
  agents: "agents",
  extensions: "extensions",
  "extensions-list": "extensions",
  "extensions-skills": "extensions",
  "extensions-mcp": "extensions",
  "extensions-memory": "extensions",
};

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

function tabFromHash(hash: string): Tab | null {
  const key = hash.replace(/^#/, "");
  if (!key) return "engine";
  return CURRENT_HASH_TAB[key] ?? MIGRATED_HASH_TAB[key] ?? null;
}

function readHashTab(): Tab {
  if (typeof window === "undefined") return "engine";
  return tabFromHash(window.location.hash) ?? "engine";
}

export function SettingsView() {
  const [tab, setTab] = useState<Tab>(readHashTab);
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(
    () => new Set([readHashTab()]),
  );
  const tabButtonRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

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

  const showTab = useCallback((nextTab: Tab) => {
    setTab(nextTab);
    setVisitedTabs((current) => {
      if (current.has(nextTab)) return current;
      const next = new Set(current);
      next.add(nextTab);
      return next;
    });
  }, []);

  const selectTab = useCallback((nextTab: Tab) => {
    showTab(nextTab);
    const nextHash = `#${TAB_HASH[nextTab]}`;
    if (window.location.hash !== nextHash) {
      window.history.pushState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${nextHash}`,
      );
    }
  }, [showTab]);

  const handleTabKeyDown = useCallback((event: React.KeyboardEvent, currentTab: Tab) => {
    const currentIndex = SETTINGS_TABS.findIndex(({ id }) => id === currentTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = SETTINGS_TABS.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = SETTINGS_TABS[nextIndex]?.id;
    if (!nextTab) return;
    selectTab(nextTab);
    tabButtonRefs.current[nextTab]?.focus();
  }, [selectTab]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const syncFromHash = () => {
      const key = window.location.hash.replace(/^#/, "");
      const nextTab = tabFromHash(window.location.hash);
      if (!nextTab) return;
      showTab(nextTab);
      if (MIGRATED_HASH_TAB[key]) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}#${TAB_HASH[nextTab]}`,
        );
      }
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, [showTab]);

  return (
    <div className="flex h-full flex-col">
      <MobileMenuHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6">
          <h1 className="text-xl font-semibold">設定</h1>
          <div className="sticky top-0 z-20 -mx-1 bg-bg/95 py-1 backdrop-blur">
            <nav
              role="tablist"
              aria-label="設定"
              className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-surface p-1 sm:flex"
            >
              {SETTINGS_TABS.map(({ id, label }) => (
                <button
                  key={id}
                  ref={(node) => { tabButtonRefs.current[id] = node; }}
                  id={`settings-tab-${id}`}
                  type="button"
                  role="tab"
                  aria-label={`${label}タブ`}
                  aria-selected={tab === id}
                  aria-controls={`settings-panel-${id}`}
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => selectTab(id)}
                  onKeyDown={(event) => handleTabKeyDown(event, id)}
                  className={cx(
                    "min-h-11 min-w-0 flex-1 rounded-lg px-3 py-2 text-sm",
                    tab === id
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-muted hover:bg-surface-2 hover:text-text",
                  )}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {visitedTabs.has("engine") && (
            <section
              id="settings-panel-engine"
              role="tabpanel"
              aria-labelledby="settings-tab-engine"
              hidden={tab !== "engine"}
              className="space-y-4"
            >
              <div className="rounded-2xl border border-border bg-surface p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Pi Coding Agent</h2>
                  <Badge
                    tone={health === null ? "neutral" : health.engineOk ? "success" : "warning"}
                    pulse={health === null || !health.engineOk}
                  >
                    {health === null ? "確認中" : health.engineOk ? "利用可" : "未接続"}
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
                {health?.error && <p role="alert" className="mt-3 text-sm text-danger">{health.error}</p>}
                {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
              </div>

              <HostRestartPanel onRestarted={reload} />
              <WebUiAuthSettings />
              <BrowserSettings />
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

          {visitedTabs.has("models") && (
            <section
              id="settings-panel-models"
              role="tabpanel"
              aria-labelledby="settings-tab-models"
              hidden={tab !== "models"}
              className="space-y-4"
            >
              <nav
                aria-label="モデル設定内"
                className="flex flex-wrap gap-2 rounded-xl border border-border bg-surface p-2 text-xs"
              >
                <a className="rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-text" href="#models-catalog">モデル一覧</a>
                <a className="rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-text" href="#models-local">ローカルLLM</a>
                <a className="rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-text" href="#models-auto">Autoモデル</a>
                <a className="rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-text" href="#models-generation">生成モデル</a>
                <a className="rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-text" href="#models-providers">プロバイダー</a>
              </nav>
              <div id="models-catalog" className="scroll-mt-24 rounded-2xl border border-border bg-surface p-4">
                <ProviderModelsPanel refreshToken={modelsRevision} />
              </div>
              <div id="models-local" className="scroll-mt-24">
                <LlamaServerSettings active={tab === "models"} />
              </div>
              <div id="models-auto" className="scroll-mt-24">
                <AutoModelSettings refreshToken={modelsRevision} />
              </div>
              <div id="models-generation" className="scroll-mt-24">
                <GenerationModelSettings refreshToken={modelsRevision} />
              </div>
              <div id="models-providers" className="scroll-mt-24 rounded-2xl border border-border bg-surface p-4">
                <ProviderAuthPanel providers={providers} onChanged={onProviderChanged} />
              </div>
            </section>
          )}

          {visitedTabs.has("agents") && (
            <section
              id="settings-panel-agents"
              role="tabpanel"
              aria-labelledby="settings-tab-agents"
              hidden={tab !== "agents"}
              className="space-y-4"
            >
              <AgentsSettings />
              <AgentsMdSettings />
            </section>
          )}

          {visitedTabs.has("extensions") && (
            <section
              id="settings-panel-extensions"
              role="tabpanel"
              aria-labelledby="settings-tab-extensions"
              hidden={tab !== "extensions"}
              className="space-y-4"
            >
              <nav
                aria-label="拡張設定内"
                className="flex flex-wrap gap-2 rounded-xl border border-border bg-surface p-2 text-xs"
              >
                <a className="rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-text" href="#extensions-list">拡張機能</a>
                <a className="rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-text" href="#extensions-skills">スキル</a>
                <a className="rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-text" href="#extensions-mcp">MCP</a>
                <a className="rounded-lg px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-text" href="#extensions-memory">メモリ</a>
              </nav>
              <div id="extensions-list" className="scroll-mt-24">
                <ExtensionsSettings />
              </div>
              <div id="extensions-skills" className="scroll-mt-24">
                <SkillsSettings />
              </div>
              <div id="extensions-mcp" className="scroll-mt-24">
                <McpSettings />
              </div>
              <div id="extensions-memory" className="scroll-mt-24">
                <MemorySettings />
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
