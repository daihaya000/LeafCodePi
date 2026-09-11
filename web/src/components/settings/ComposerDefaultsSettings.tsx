"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { readStoredThinkingLevel, resolveThinkingLevel, writeStoredThinkingLevel } from "@/lib/thinking-levels";
import { modelOptionForValue } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import type { ModelOption, ThinkingLevel } from "@/lib/types";

const SELECT_CLASS = "mt-2 h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm";

export function ComposerDefaultsSettings({ refreshToken = 0 }: { refreshToken?: number }) {
  const [defaults, setDefaults] = useState<ComposerDefaults>(() => readComposerDefaults());
  const [models, setModels] = useState<ModelOption[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    () => readStoredThinkingLevel() ?? "off",
  );
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
  // ModelSelect/HomeView と同じ照合にし、integrated / 旧アカウント接頭辞でも effort を失わない。
  const selectedModel = modelOptionForValue(modelOptions, defaults.model);
  const thinkingLevels = useMemo(() => selectedModel?.thinkingLevels ?? [], [selectedModel]);
  const modelKnown = Boolean(selectedModel);
  const selectModelValue = selectedModel?.value ?? defaults.model;

  useEffect(() => {
    if (!selectedModel || selectedModel.value === defaults.model) return;
    // 旧アカウント接頭辞値は候補の正規 value へ寄せ、select の不一致と未接続表示を防ぐ。
    change({ model: selectedModel.value });
  }, [defaults.model, selectedModel]);

  useEffect(() => {
    if (!selectedModel || selectedModel.value === AUTO_MODEL_OPTION.value) return;
    const safeLevel = resolveThinkingLevel(thinkingLevels, thinkingLevel);
    if (safeLevel !== thinkingLevel) {
      setThinkingLevel(safeLevel);
      writeStoredThinkingLevel(safeLevel);
    }
  }, [selectedModel, thinkingLevel, thinkingLevels]);

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
            value={selectModelValue}
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
          <span className="font-medium">effort</span>
          {selectedModel?.value === AUTO_MODEL_OPTION.value ? (
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
          ) : (
            <ThinkingSelect
              levels={thinkingLevels}
              value={thinkingLevel}
              onChange={(level) => {
                setThinkingLevel(level);
                writeStoredThinkingLevel(level);
              }}
              className="mt-2 h-9 w-full [&>button]:text-sm"
            />
          )}
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
