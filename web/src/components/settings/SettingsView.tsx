"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { MobileMenuHeader } from "@/components/shell/MobileMenuHeader";
import { ProviderAuthPanel } from "@/components/settings/ProviderAuthPanel";
import { ProviderModelsPanel } from "@/components/settings/ProviderModelsPanel";
import { AutoModelSettings } from "@/components/settings/AutoModelSettings";
import { GenerationModelSettings } from "@/components/settings/GenerationModelSettings";
import { JevModelSettings } from "@/components/settings/JevModelSettings";
import { LlamaServerSettings } from "@/components/settings/LlamaServerSettings";
import { HostRestartPanel } from "@/components/settings/HostRestartPanel";
import { ProfileSettings } from "@/components/settings/ProfileSettings";
import { AgentsMdSettings } from "@/components/settings/AgentsMdSettings";
import { SoulMdSettings } from "@/components/settings/SoulMdSettings";
import { ToolsMdSettings } from "@/components/settings/ToolsMdSettings";
import { WorkflowMdSettings } from "@/components/settings/WorkflowMdSettings";
import { DesignMdSettings } from "@/components/settings/DesignMdSettings";
import { UserMdSettings } from "@/components/settings/UserMdSettings";
import { MemorySettings } from "@/components/settings/MemorySettings";
import { CompactionSettings } from "@/components/settings/CompactionSettings";
import { SessionLabelSettings } from "@/components/settings/SessionLabelSettings";
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
import { TtsSettings } from "@/components/settings/TtsSettings";
import { SystemSafetySettings } from "@/components/settings/SystemSafetySettings";
import { BotDefaultsSettings } from "@/components/settings/BotDefaultsSettings";
import {
  ComposerDefaultsSettings,
  ComposerPromptPresetsSettings,
} from "@/components/settings/ComposerDefaultsSettings";
import { BotsMdSettings } from "@/components/settings/BotsMdSettings";
import { Badge, cx, ThemeToggle } from "@/components/ui";
import { getJson } from "@/lib/client";
import type { HealthDto, ProviderAuthDto } from "@/lib/types";

type Tab = "engine" | "models" | "agents" | "prompts" | "extensions" | "bots";

const SETTINGS_TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "engine", label: "エンジン" },
  { id: "models", label: "モデル" },
  { id: "prompts", label: "プロンプト" },
  { id: "agents", label: "エージェント" },
  { id: "bots", label: "ボット" },
  { id: "extensions", label: "拡張" },
];

const TAB_HASH: Readonly<Record<Tab, string>> = {
  engine: "engine",
  models: "models",
  agents: "agents",
  prompts: "prompts",
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
  "models-jev": "models",
  "models-providers": "models",
  agents: "agents",
  "agents-skills": "agents",
  prompts: "prompts",
  "prompts-common": "prompts",
  "prompts-code": "prompts",
  "prompts-bot": "prompts",
  bots: "bots",
  "bots-skills": "bots",
  extensions: "extensions",
  "extensions-list": "extensions",
  "extensions-intercom": "extensions",
  "extensions-skills": "agents",
  "extensions-mcp": "extensions",
  "extensions-memory": "engine",
};

// 廃止したカテゴリ・サブタブの旧ハッシュを移行先へ届ける。
const MIGRATED_HASH_TAB: Readonly<Record<string, Tab>> = {
  "general-basic": "engine",
  "general-response": "engine",
  "general-agents": "prompts",
  "general-integrations": "extensions",
  "engine-overview": "engine",
  "engine-basic": "engine",
  "engine-response": "engine",
  "agents-instructions-heading": "prompts",
  "bots-instructions-heading": "prompts",
};

function tabFromHash(hash: string): Tab | null {
  const key = hash.replace(/^#/, "");
  if (!key) return "engine";
  return CURRENT_HASH_TAB[key] ?? MIGRATED_HASH_TAB[key] ?? null;
}

type SettingsGroupProps = {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
};

function SettingsGroup({ title, children }: SettingsGroupProps) {
  return (
    <section aria-label={title} className="space-y-3">
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
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [jevRevision, setJevRevision] = useState(0);
  const sharedRevision = modelsRevision + catalogRevision;
  const [error, setError] = useState<string | null>(null);
  const reloadGenerationRef = useRef(0);

  useEffect(() => () => {
    reloadGenerationRef.current += 1;
  }, []);

  const reload = useCallback(() => {
    const generation = ++reloadGenerationRef.current;
    const isCurrent = () => generation === reloadGenerationRef.current;
    void getJson<HealthDto>("/api/health")
      .then((result) => {
        if (!isCurrent()) return;
        setHealth(result);
        setError(null);
      })
      .catch(() => {
        if (isCurrent()) setError("ヘルスの取得に失敗しました");
      });
    void getJson<{ providers: ProviderAuthDto[] }>("/api/providers")
      .then((result) => {
        if (isCurrent()) setProviders(result.providers);
      })
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
    <div className="flex h-full min-w-0 w-full flex-col">
      <MobileMenuHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6">
          <h1 className="text-xl font-semibold">設定</h1>
          <div className="sticky top-0 z-20 -mx-1 bg-bg/95 py-1 backdrop-blur">
            <nav
              role="tablist"
              aria-label="設定"
              className="flex min-w-0 gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden @xl:overflow-x-visible"
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
                    "min-h-11 min-w-[7rem] shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm @xl:min-w-0 @xl:flex-1 @xl:shrink",
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
                description="Pi Coding Agent の状態を確認し、WebUI とホストを管理します。"
              >
                <div className="grid gap-4 @3xl:grid-cols-2">
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
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
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
                  <ProfileSettings />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="engine-access-heading"
                title="アクセスと安全"
                description="WebUI への接続方法と、システム操作に対する安全ガードを設定します。"
              >
                <div className="grid gap-4 @4xl:grid-cols-2">
                  <WebUiAuthSettings />
                  <SystemSafetySettings />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="engine-response-heading"
                title="応答"
                description="翻訳、コンテキスト節約、自動再開など、応答時の動作を設定します。"
              >
                <div className="grid gap-4 @4xl:grid-cols-2">
                  <ReasoningTranslationSettings />
                  <CompactionSettings />
                  <HangTimeoutSettings />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="engine-display-heading"
                title="表示と通知"
                description="表示、通知音、メッセージ移動ボタン、セッション開始時のペイン動作を設定します。"
              >
                <div className="grid gap-4 @4xl:grid-cols-2">
                  <div className="rounded-2xl border border-border bg-surface p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold">テーマ</h3>
                        <p className="mt-1 text-xs text-muted">WebUIの表示テーマを切り替えます。</p>
                      </div>
                      <ThemeToggle />
                    </div>
                  </div>
                  <BrowserSettings />
                  <NavigatorSettings />
                  <NotificationSoundSettings />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="models-local-heading"
                title="ローカル推論"
                description="llama-server のモデル、起動状態、推論パラメータ、読み上げを設定します。"
              >
                <div id="models-local" className="scroll-mt-24 grid gap-4 @4xl:grid-cols-2">
                  <LlamaServerSettings active={tab === "engine"} />
                  <TtsSettings />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="extensions-memory-heading"
                title="メモリ"
                description="永続メモリを管理し、容量、保存タイミング、保存済みデータを確認します。"
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
                description="利用可能なモデルの有効状態と表示順を管理します。"
              >
                <div id="models-catalog" className="scroll-mt-24 rounded-2xl border border-border bg-surface p-4">
                  <ProviderModelsPanel refreshToken={sharedRevision} onProviderCatalogChange={() => setJevRevision((revision) => revision + 1)} />
                </div>
              </SettingsGroup>

              <SettingsGroup id="models-jev-heading" title="Jevモデル">
                <div id="models-jev" className="scroll-mt-24 rounded-2xl border border-border bg-surface p-4">
                  <JevModelSettings refreshToken={modelsRevision + jevRevision} onProviderCatalogChange={() => setCatalogRevision((revision) => revision + 1)} />
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="models-generation-heading"
                title="自動選択と生成"
                description="起動時の既定値、送信プロンプト、自動ルーティングと、タイトル・提案などに使う生成モデルを設定します。"
              >
                <div className="space-y-4">
                  <ComposerDefaultsSettings refreshToken={sharedRevision} />
                  <ComposerPromptPresetsSettings />
                  <div id="models-auto" className="scroll-mt-24">
                    <AutoModelSettings refreshToken={sharedRevision} />
                  </div>
                  <div id="models-generation" className="scroll-mt-24">
                    <GenerationModelSettings refreshToken={sharedRevision} />
                  </div>
                  <div id="models-session-labels" className="scroll-mt-24">
                    <SessionLabelSettings />
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
                id="agents-skills-heading"
                title="エージェント用スキル"
                description="エージェントの通常タスクに適用するスキルを管理します。"
              >
                <div id="agents-skills" className="scroll-mt-24">
                  <SkillsSettings scope="code" />
                </div>
              </SettingsGroup>
            </section>
          )}

          {visitedTabs.has("prompts") && (
            <section
              id="settings-panel-prompts"
              role="tabpanel"
              aria-labelledby="settings-tab-prompts"
              hidden={tab !== "prompts"}
              className="space-y-8"
            >
              <SettingsGroup
                id="prompts-common-heading"
                title="共通"
              >
                <div id="prompts-common" className="scroll-mt-24">
                  <UserMdSettings />
                </div>
              </SettingsGroup>
              <SettingsGroup
                id="prompts-code-heading"
                title="Code"
              >
                <div id="prompts-code" className="scroll-mt-24 space-y-4">
                  <SoulMdSettings />
                  <AgentsMdSettings />
                  <WorkflowMdSettings />
                  <ToolsMdSettings />
                  <DesignMdSettings />
                </div>
              </SettingsGroup>
              <SettingsGroup
                id="prompts-bot-heading"
                title="Bot"
              >
                <div id="prompts-bot" className="scroll-mt-24">
                  <BotsMdSettings />
                </div>
              </SettingsGroup>
            </section>
          )}

          {visitedTabs.has("bots") && (
            <section id="settings-panel-bots" role="tabpanel" aria-labelledby="settings-tab-bots" hidden={tab !== "bots"} className="space-y-8">
              <SettingsGroup id="bots-defaults-heading" title={"\u30dc\u30c3\u30c8\u306e\u521d\u671f\u8a2d\u5b9a"} description={"\u65b0\u3057\u3044\u30dc\u30c3\u30c8\u306b\u9069\u7528\u3059\u308b\u5171\u901a\u306e\u65e2\u5b9a\u5024\u3067\u3059\u3002\u65e2\u5b58\u306e\u30dc\u30c3\u30c8\u306f\u5909\u66f4\u3057\u307e\u305b\u3093\u3002"}>
                <BotDefaultsSettings />
              </SettingsGroup>
              <SettingsGroup
                id="bots-skills-heading"
                title="ボット用スキル"
                description="すべてのボットの会話とルームに適用するスキルを管理します。"
              >
                <div id="bots-skills" className="scroll-mt-24">
                  <SkillsSettings scope="bot" />
                </div>
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
                id="extensions-mcp-heading"
                title="MCP"
                description="MCP サーバーの有効状態と認証情報を管理します。"
              >
                <div id="extensions-mcp" className="scroll-mt-24">
                  <McpSettings />
                </div>
              </SettingsGroup>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
