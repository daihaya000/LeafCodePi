"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
import { SystemSafetySettings } from "@/components/settings/SystemSafetySettings";
import { BotDefaultsSettings } from "@/components/settings/BotDefaultsSettings";
import { ComposerDefaultsSettings } from "@/components/settings/ComposerDefaultsSettings";
import { BotsMdSettings } from "@/components/settings/BotsMdSettings";
import { CommitGuardSettings } from "@/components/settings/CommitGuardSettings";
import { Badge, cx } from "@/components/ui";
import { getJson } from "@/lib/client";
import type { HealthDto, ProviderAuthDto } from "@/lib/types";

type Tab = "engine" | "models" | "agents" | "extensions" | "bots";

const SETTINGS_TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "engine", label: "エンジン" },
  { id: "models", label: "モデル" },
  { id: "agents", label: "エージェント" },
  { id: "extensions", label: "拡張" },
  { id: "bots", label: "ボット" },
];

const TAB_HASH: Readonly<Record<Tab, string>> = {
  engine: "engine",
  models: "models",
  agents: "agents",
  bots: "bots",
  extensions: "extensions",
};

const CURRENT_HASH_TAB: Readonly<Record<string, Tab>> = {
  engine: "engine",
  models: "models",
  "models-catalog": "models",
  "models-local": "engine",
  "models-auto": "models",
  "models-generation": "models",
  "models-providers": "models",
  agents: "agents",
  bots: "bots",
  extensions: "extensions",
  "extensions-list": "extensions",
  "extensions-skills": "extensions",
  "extensions-mcp": "extensions",
  "extensions-memory": "engine",
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

type SettingsGroupProps = {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
};

function SettingsGroup({ id, title, description, children }: SettingsGroupProps) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <header className="px-1">
        <h2 id={id} className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-xs text-muted">{description}</p>
      </header>
      {children}
    </section>
  );
}

export function SettingsView() {
  // SSRとの一致を保つため初回はhashに依存せず固定値で初期化し、
  // mount直後の syncFromHash エフェクトで実際のhashへ切り替える（hydration mismatch回避）。
  const [tab, setTab] = useState<Tab>("engine");
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set(["engine"]));
  const tabButtonRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const [health, setHealth] = useState<HealthDto | null>(null);
  const [providers, setProviders] = useState<ProviderAuthDto[]>([]);
  const [modelsRevision, setModelsRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void getJson<HealthDto>("/api/health")
      .then((result) => {
        setHealth(result);
        setError(null);
      })
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
              className="space-y-8"
            >
              <SettingsGroup
                id="engine-runtime-heading"
                title="ランタイム"
                description="Pi Coding Agent の状態を確認し、WebUI とトレイホストを管理します。"
              >
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-2xl border border-border bg-surface p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold">Pi Coding Agent</h3>
                      <Badge
                        tone={
                          health === null && !error
                            ? "neutral"
                            : health?.engineOk
                              ? "success"
                              : "warning"
                        }
                        pulse={(health === null && !error) || !health?.engineOk}
                      >
                        {health === null && !error ? "確認中" : health?.engineOk ? "利用可" : "未接続"}
                      </Badge>
                    </div>
                    <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
                      <dt className="text-muted">エンジン</dt>
                      <dd>Pi SDK（プロセス内埋め込み）</dd>
                      <dt className="text-muted">バージョン</dt>
                      <dd className="font-mono">{health?.version ?? "-"}</dd>
                      <dt className="text-muted">データ</dt>
                      <dd className="break-all font-mono text-xs">{health?.dataDir ?? "-"}</dd>
                      <dt className="text-muted">有効モデル数</dt>
                      <dd>{health?.modelCount ?? 0}</dd>
                    </dl>
                    {health?.error && <p role="alert" className="mt-3 text-sm text-danger">{health.error}</p>}
                    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
                  </div>
                  <HostRestartPanel onRestarted={reload} />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="engine-access-heading"
                title="アクセスと安全"
                description="WebUI への接続方法と、システム操作・コミットに対する安全ガードを設定します。"
              >
                <div className="space-y-4">
                  <WebUiAuthSettings />
                  <SystemSafetySettings />
                  <CommitGuardSettings />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="engine-response-heading"
                title="応答"
                description="翻訳、コンテキスト節約、自動再開など、応答時の動作を設定します。"
              >
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="xl:col-span-2">
                    <ReasoningTranslationSettings />
                  </div>
                  <CompactionSettings />
                  <HangTimeoutSettings />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="engine-display-heading"
                title="表示と通知"
                description="起動時の既定値、表示、通知音、メッセージ移動ボタンを設定します。"
              >
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="xl:col-span-2">
                    <ComposerDefaultsSettings refreshToken={modelsRevision} />
                  </div>
                  <BrowserSettings />
                  <NavigatorSettings />
                  <NotificationSoundSettings />
                  <div className="rounded-2xl border border-border bg-surface p-4">
                    <h3 className="text-sm font-semibold">テーマ</h3>
                    <p className="mt-1 text-xs text-muted">
                      サイドバー右下のアイコンから、ライト / ダーク / システムを切り替えます。
                    </p>
                  </div>
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="models-local-heading"
                title="ローカル推論"
                description="llama-server のモデル、起動状態、推論パラメータを設定します。"
              >
                <div id="models-local" className="scroll-mt-24">
                  <LlamaServerSettings active={tab === "engine"} />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="extensions-memory-heading"
                title="メモリ"
                description="永続メモリの動作、容量、保存タイミングを設定し、保存済みデータを検索します。"
              >
                <div id="extensions-memory" className="scroll-mt-24">
                  <MemorySettings />
                </div>
              </SettingsGroup>
            </section>
          )}

          {visitedTabs.has("models") && (
            <section
              id="settings-panel-models"
              role="tabpanel"
              aria-labelledby="settings-tab-models"
              hidden={tab !== "models"}
              className="space-y-8"
            >
              <SettingsGroup
                id="models-catalog-heading"
                title="モデルカタログ"
                description="利用可能なモデルの有効状態、表示順、コンテキストサイズを管理します。"
              >
                <div id="models-catalog" className="scroll-mt-24 rounded-2xl border border-border bg-surface p-4">
                  <ProviderModelsPanel refreshToken={modelsRevision} />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="models-generation-heading"
                title="自動選択と生成"
                description="自動ルーティングと、タイトル・提案などに使う生成モデルを設定します。"
              >
                <div className="space-y-4">
                  <div id="models-auto" className="scroll-mt-24">
                    <AutoModelSettings refreshToken={modelsRevision} />
                  </div>
                  <div id="models-generation" className="scroll-mt-24">
                    <GenerationModelSettings refreshToken={modelsRevision} />
                  </div>
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="models-providers-heading"
                title="プロバイダー接続"
                description="各プロバイダーのログイン、APIキー、アカウント、接続先を管理します。"
              >
                <div id="models-providers" className="scroll-mt-24 rounded-2xl border border-border bg-surface p-4">
                  <ProviderAuthPanel providers={providers} onChanged={onProviderChanged} />
                </div>
              </SettingsGroup>
            </section>
          )}

          {visitedTabs.has("agents") && (
            <section
              id="settings-panel-agents"
              role="tabpanel"
              aria-labelledby="settings-tab-agents"
              hidden={tab !== "agents"}
              className="space-y-8"
            >
              <SettingsGroup
                id="agents-management-heading"
                title="エージェント運用"
                description="サブエージェントの有効状態、モデル、Effort、定義を管理します。"
              >
                <AgentsSettings />
              </SettingsGroup>
              <SettingsGroup
                id="agents-instructions-heading"
                title="共通指示"
                description="すべてのプロジェクトとセッションに適用する AGENTS.md を編集します。"
              >
                <AgentsMdSettings />
              </SettingsGroup>
            </section>
          )}

          {visitedTabs.has("bots") && (
            <section id="settings-panel-bots" role="tabpanel" aria-labelledby="settings-tab-bots" hidden={tab !== "bots"} className="space-y-8">
              <SettingsGroup id="bots-defaults-heading" title={"\u30dc\u30c3\u30c8\u306e\u521d\u671f\u8a2d\u5b9a"} description={"\u65b0\u3057\u3044\u30dc\u30c3\u30c8\u306b\u9069\u7528\u3059\u308b\u5171\u901a\u306e\u65e2\u5b9a\u5024\u3067\u3059\u3002\u65e2\u5b58\u306e\u30dc\u30c3\u30c8\u306f\u5909\u66f4\u3057\u307e\u305b\u3093\u3002"}>
                <BotDefaultsSettings />
              </SettingsGroup>
              <SettingsGroup
                id="bots-instructions-heading"
                title="共通指示"
                description="すべてのボットに適用する BOTS.md を編集します。"
              >
                <BotsMdSettings />
              </SettingsGroup>
            </section>
          )}

          {visitedTabs.has("extensions") && (
            <section
              id="settings-panel-extensions"
              role="tabpanel"
              aria-labelledby="settings-tab-extensions"
              hidden={tab !== "extensions"}
              className="space-y-8"
            >
              <SettingsGroup
                id="extensions-management-heading"
                title="拡張機能の管理"
                description="拡張機能を有効化・無効化し、現在の読み込み先を確認します。"
              >
                <div id="extensions-list" className="scroll-mt-24">
                  <ExtensionsSettings />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="extensions-tools-heading"
                title="スキルと連携"
                description="スキルと MCP サーバーの有効状態をまとめて管理します。"
              >
                <div className="grid gap-4 xl:grid-cols-2">
                  <div id="extensions-skills" className="scroll-mt-24">
                    <SkillsSettings />
                  </div>
                  <div id="extensions-mcp" className="scroll-mt-24">
                    <McpSettings />
                  </div>
                </div>
              </SettingsGroup>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
