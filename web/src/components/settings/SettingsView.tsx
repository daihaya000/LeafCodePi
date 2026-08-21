"use client";

import { useCallback, useEffect, useState } from "react";
import { MobileMenuHeader } from "@/components/shell/MobileMenuHeader";
import { ProviderAuthPanel } from "@/components/settings/ProviderAuthPanel";
import { ProviderModelsPanel } from "@/components/settings/ProviderModelsPanel";
import { LlamaServerSettings } from "@/components/settings/LlamaServerSettings";
import { HostRestartPanel } from "@/components/settings/HostRestartPanel";
import { AgentsMdSettings } from "@/components/settings/AgentsMdSettings";
import { CompactionSettings } from "@/components/settings/CompactionSettings";
import { SkillsSettings } from "@/components/settings/SkillsSettings";
import { ExtensionsSettings } from "@/components/settings/ExtensionsSettings";
import { McpSettings } from "@/components/settings/McpSettings";
import { AgentsSettings } from "@/components/settings/AgentsSettings";
import { ProviderIcon } from "@/components/ProviderIcon";
import { Badge, cx } from "@/components/ui";
import { getJson } from "@/lib/client";
import type { HealthDto, ModelOption, ProviderAuthDto } from "@/lib/types";

type Tab = "engine" | "models" | "general";

export function SettingsView() {
  const [tab, setTab] = useState<Tab>("engine");
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [providers, setProviders] = useState<ProviderAuthDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void Promise.allSettled([
      getJson<HealthDto>("/api/health"),
      getJson<{ models: ModelOption[] }>("/api/models"),
      getJson<{ providers: ProviderAuthDto[] }>("/api/providers"),
    ]).then(([healthRes, modelRes, providerRes]) => {
      if (healthRes.status === "fulfilled") setHealth(healthRes.value);
      else setError("ヘルスの取得に失敗しました");
      if (modelRes.status === "fulfilled") setModels(modelRes.value.models);
      if (providerRes.status === "fulfilled") setProviders(providerRes.value.providers);
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="flex h-full flex-col">
      <MobileMenuHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          <h1 className="text-xl font-semibold">設定</h1>
          <div className="flex gap-1 rounded-xl border border-border bg-surface p-1">
            {(
              [
                ["engine", "エンジン"],
                ["models", "モデル"],
                ["general", "一般"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cx(
                  "flex-1 rounded-lg px-3 py-1.5 text-sm",
                  tab === id ? "bg-surface-2 font-medium text-text" : "text-muted hover:text-text",
                )}
              >
                {label}
              </button>
            ))}
          </div>

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
            </section>
          )}

          {tab === "models" && (
            <section className="space-y-4">
              <div className="rounded-2xl border border-border bg-surface p-4">
                <ProviderAuthPanel providers={providers} onChanged={reload} />
              </div>

              <div className="rounded-2xl border border-border bg-surface p-4">
                <ProviderModelsPanel />
              </div>

              <div className="rounded-2xl border border-border bg-surface p-4">
                <h2 className="mb-2 text-sm font-semibold">利用可能なモデル（有効のみ）</h2>
                <ul className="max-h-80 space-y-1 overflow-y-auto">
                  {models.length === 0 && <li className="text-sm text-muted">認証済みモデルがありません</li>}
                  {models.map((model) => (
                    <li key={model.value} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
                      <ProviderIcon providerID={model.providerID} size={16} />
                      <span className="font-medium">{model.label}</span>
                      <span className="ml-auto font-mono text-xs text-muted">{model.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {tab === "general" && (
            <section className="space-y-4">
              <AgentsMdSettings />
              <SkillsSettings />
              <ExtensionsSettings />
              <McpSettings />
              <AgentsSettings />
              <CompactionSettings />
              <div className="rounded-2xl border border-border bg-surface p-4 text-sm text-muted">
                <p>テーマはサイドバー右下のアイコンから切り替えます（ライト / ダーク / システム）。</p>
                <p className="mt-2">
                  サブスクログイン・モデルの有効／無効・並び替え・有効モデル一覧は「モデル」タブです。ローカル LLM（llama-server）の起動と
                  WebUI／トレイホストの再起動は「エンジン」タブです。
                </p>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
