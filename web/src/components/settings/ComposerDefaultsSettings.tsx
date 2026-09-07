"use client";

import { useEffect, useRef, useState } from "react";
import { getJson } from "@/lib/client";
import {
  AUTO_MODEL_OPTION,
  AUTO_OPTIMIZE_MODES,
  autoOptimizeModeLabel,
  type AutoOptimizeMode,
} from "@/lib/auto-model";
import {
  hasStoredComposerDefaults,
  readComposerDefaults,
  readComposerDefaultsFromServer,
  subscribeComposerDefaults,
  writeComposerDefaults,
  type ComposerDefaults,
} from "@/lib/composer-defaults";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import type { ModelOption } from "@/lib/types";

const SELECT_CLASS = "mt-2 h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm";

export function ComposerDefaultsSettings({ refreshToken = 0 }: { refreshToken?: number }) {
  const [defaults, setDefaults] = useState<ComposerDefaults>(() => readComposerDefaults());
  const [models, setModels] = useState<ModelOption[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const touchedRef = useRef(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getJson<{ models: ModelOption[] }>("/api/models"),
      getJson<{ agents: { name: string; enabled: boolean }[] }>("/api/agents"),
    ])
      .then(([modelResult, agentResult]) => {
        if (!active) return;
        setModels(modelResult.models ?? []);
        setAgents((agentResult.agents ?? []).filter((a) => a.enabled).map((a) => a.name));
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "モデル・エージェント一覧を取得できません");
      });
    return () => {
      active = false;
    };
  }, [refreshToken]);

  useEffect(
    () =>
      subscribeComposerDefaults(() => {
        touchedRef.current = true;
        setDefaults(readComposerDefaults());
      }),
    [],
  );

  useEffect(() => {
    let active = true;
    if (hasStoredComposerDefaults()) return;
    void readComposerDefaultsFromServer().then((snapshot) => {
      if (!active || !snapshot || touchedRef.current || hasStoredComposerDefaults()) return;
      writeComposerDefaults(snapshot);
      setDefaults(snapshot);
    });
    return () => {
      active = false;
    };
  }, []);

  const change = (patch: Partial<ComposerDefaults>) => {
    touchedRef.current = true;
    const next = { ...defaults, ...patch };
    setDefaults(next);
    writeComposerDefaults(next);
  };

  const modelOptions = [AUTO_MODEL_OPTION, ...models];
  const modelKnown = modelOptions.some((option) => option.value === defaults.model);

  return (
    <section aria-labelledby="composer-defaults-heading" className="rounded-2xl border border-border bg-surface p-4">
      <h3 id="composer-defaults-heading" className="text-sm font-semibold">起動時の既定値</h3>
      <p className="mt-1 text-xs text-muted">
        WebUI を開いたときに Composer へ適用するモデル・effort・エージェントです。セッション中の変更は保持されます。
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        <label className="text-sm">
          <span className="font-medium">モデル</span>
          <select
            aria-label="既定のモデル"
            value={defaults.model}
            onChange={(event) => change({ model: event.target.value })}
            className={SELECT_CLASS}
          >
            {!modelKnown && <option value={defaults.model}>{defaults.model}（未接続）</option>}
            {modelOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="font-medium">effort（Auto最適化方針）</span>
          <select
            aria-label="既定のeffort"
            value={defaults.autoOptimize}
            onChange={(event) => change({ autoOptimize: event.target.value as AutoOptimizeMode })}
            className={SELECT_CLASS}
          >
            {AUTO_OPTIMIZE_MODES.map((mode) => (
              <option key={mode} value={mode}>{autoOptimizeModeLabel(mode)}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="font-medium">エージェント</span>
          <select
            aria-label="既定のエージェント"
            value={defaults.agent}
            onChange={(event) => change({ agent: event.target.value })}
            className={SELECT_CLASS}
          >
            <option value={AUTO_AGENT_VALUE}>Auto</option>
            {!agents.includes(defaults.agent) && defaults.agent !== AUTO_AGENT_VALUE && (
              <option value={defaults.agent}>{defaults.agent}（無効）</option>
            )}
            {agents.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
    </section>
  );
}
