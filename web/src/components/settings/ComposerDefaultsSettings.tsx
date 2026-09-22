"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJson } from "@/lib/client";
import { AUTO_MODEL_OPTION } from "@/lib/auto-model";
import {
  AUTO_MODEL_ENABLED_SETTING_KEY,
  hasStoredAutoSetting,
  readAutoModelEnabled,
  readAutoSettingsFromServer,
  subscribeAutoSetting,
  writeAutoModelEnabled,
} from "@/lib/auto-settings";
import {
  hasStoredComposerDefaults,
  readComposerDefaults,
  readComposerDefaultsFromServer,
  subscribeComposerDefaults,
  writeComposerDefaults,
  type ComposerDefaults,
} from "@/lib/composer-defaults";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import {
  MAX_COMPOSER_PROMPT_PRESETS_VALUE_CHARS,
  hasStoredComposerPromptPresets,
  MAX_COMPOSER_PROMPT_PRESETS,
  MAX_COMPOSER_PROMPT_PRESET_PROMPT_CHARS,
  readComposerPromptPresets,
  readComposerPromptPresetsFromServer,
  subscribeComposerPromptPresets,
  writeComposerPromptPresets,
  type ComposerPromptPreset,
} from "@/lib/composer-prompt-presets";
import { readStoredThinkingLevel, resolveThinkingLevel, writeStoredThinkingLevel } from "@/lib/thinking-levels";
import { ModelSelect, modelOptionForValue } from "@/components/ModelSelect";
import { AgentSelect } from "@/components/AgentSelect";
import { AutoOptimizeSelect } from "@/components/AutoOptimizeSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import type { ModelOption, ThinkingLevel } from "@/lib/types";

export function ComposerDefaultsSettings({ refreshToken = 0 }: { refreshToken?: number }) {
  const [defaults, setDefaults] = useState<ComposerDefaults>(() => readComposerDefaults());
  const [models, setModels] = useState<ModelOption[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [autoAgentEnabled, setAutoAgentEnabled] = useState(false);
  const [autoModelEnabled, setAutoModelEnabled] = useState(() => readAutoModelEnabled());
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    () => readStoredThinkingLevel() ?? "off",
  );
  const [error, setError] = useState<string | null>(null);
  const touchedRef = useRef(false);
  const autoModelTouchedRef = useRef(false);
  const thinkingLevelTouchedRef = useRef(false);
  const thinkingModelRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getJson<{ models: ModelOption[] }>("/api/models"),
      getJson<{ agents: { name: string; enabled: boolean }[]; autoEnabled?: boolean }>("/api/agents"),
    ])
      .then(([modelResult, agentResult]) => {
        if (!active) return;
        setModels(modelResult.models ?? []);
        setAutoAgentEnabled(agentResult.autoEnabled === true);
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
    const unsubscribe = subscribeAutoSetting(AUTO_MODEL_ENABLED_SETTING_KEY, () => {
      autoModelTouchedRef.current = true;
      setAutoModelEnabled(readAutoModelEnabled());
    });
    void readAutoSettingsFromServer().then((snapshot) => {
      if (
        !active ||
        snapshot.modelEnabled === undefined ||
        autoModelTouchedRef.current ||
        hasStoredAutoSetting(AUTO_MODEL_ENABLED_SETTING_KEY)
      ) return;
      writeAutoModelEnabled(snapshot.modelEnabled);
      setAutoModelEnabled(snapshot.modelEnabled);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

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

  const change = useCallback((patch: Partial<ComposerDefaults>) => {
    touchedRef.current = true;
    const next = { ...defaults, ...patch };
    setDefaults(next);
    writeComposerDefaults(next);
  }, [defaults]);

  const modelOptions = autoModelEnabled ? [AUTO_MODEL_OPTION, ...models] : models;
  // ModelSelect/HomeView と同じ照合にし、integrated / 旧アカウント接頭辞でも effort を失わない。
  const selectedModel = modelOptionForValue(modelOptions, defaults.model);
  const thinkingLevels = useMemo(() => selectedModel?.thinkingLevels ?? [], [selectedModel]);
  const modelKnown = Boolean(selectedModel);
  const selectModelValue = selectedModel?.value ?? defaults.model;
  // AgentSelect は Composer と同じく不明値を正規化して表示するため、
  // 無効な既定値の情報はモデル側の未接続表示と同型の警告行で残す。
  const agentKnown = (autoAgentEnabled && defaults.agent === AUTO_AGENT_VALUE) || agents.includes(defaults.agent);

  useEffect(() => {
    if (autoModelEnabled || defaults.model !== AUTO_MODEL_OPTION.value || !models[0]) return;
    change({ model: models[0].value });
  }, [autoModelEnabled, change, defaults.model, models]);

  useEffect(() => {
    if (!selectedModel || selectedModel.value === defaults.model) return;
    // 旧アカウント接頭辞値は候補の正規 value へ寄せ、select の不一致と未接続表示を防ぐ。
    change({ model: selectedModel.value });
  }, [defaults.model, selectedModel, change]);

  useEffect(() => {
    if (!selectedModel || selectedModel.value === AUTO_MODEL_OPTION.value || !selectedModel.thinkingLevels) return;
    if (thinkingModelRef.current !== selectedModel.value) {
      thinkingModelRef.current = selectedModel.value;
      thinkingLevelTouchedRef.current = false;
    }
    const preferred =
      !thinkingLevelTouchedRef.current && selectedModel.defaultThinkingLevel
        ? selectedModel.defaultThinkingLevel
        : thinkingLevel;
    const safeLevel = resolveThinkingLevel(thinkingLevels, preferred);
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
        <div className="text-sm">
          <span className="font-medium">モデル</span>
          <div className="mt-2">
            <ModelSelect
              value={selectModelValue}
              options={modelOptions}
              onChange={(value) => {
                thinkingLevelTouchedRef.current = false;
                change({ model: value });
              }}
              ariaLabel="既定のモデル"
              emptyLabel={modelKnown ? "モデルなし" : `${defaults.model}（未接続）`}
              className="h-9 w-full"
            />
          </div>
        </div>
        <div className="text-sm">
          <span className="font-medium">effort</span>
          <div className="mt-2">
            {selectedModel?.value === AUTO_MODEL_OPTION.value ? (
              <AutoOptimizeSelect
                value={defaults.autoOptimize}
                onChange={(value) => change({ autoOptimize: value })}
                className="h-9 w-full"
              />
            ) : (
              <ThinkingSelect
                levels={thinkingLevels}
                value={thinkingLevel}
                onChange={(level) => {
                  thinkingLevelTouchedRef.current = true;
                  setThinkingLevel(level);
                  writeStoredThinkingLevel(level);
                }}
                className="h-9 w-full"
              />
            )}
          </div>
        </div>
        <div className="text-sm">
          <span className="font-medium">エージェント</span>
          <div className="mt-2">
            <AgentSelect
              value={defaults.agent}
              agents={agents}
              autoEnabled={autoAgentEnabled}
              onChange={(value) => change({ agent: value })}
              className="h-9 w-full"
            />
            {agents.length > 0 && !agentKnown && (
              <p className="mt-1 text-xs text-warning">「{defaults.agent}」は無効です。存在するエージェントを選び直してください。</p>
            )}
          </div>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
    </section>
  );
}

type PromptPresetDraft = { prompt: string };

const EMPTY_PROMPT_PRESET_DRAFT: PromptPresetDraft = { prompt: "" };

/** Manage the body-only prompt presets shown by every composer. */
export function ComposerPromptPresetsSettings() {
  // SSRとの一致を保つため、localStorageはhydration後に読み込む。
  const [presets, setPresets] = useState<ComposerPromptPreset[]>([]);
  const [draft, setDraft] = useState<PromptPresetDraft>(EMPTY_PROMPT_PRESET_DRAFT);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touchedRef = useRef(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeComposerPromptPresets(() => {
      touchedRef.current = true;
      setPresets(readComposerPromptPresets());
    });
    if (hasStoredComposerPromptPresets()) {
      setPresets(readComposerPromptPresets());
    } else {
      void readComposerPromptPresetsFromServer().then((snapshot) => {
        if (!active || snapshot === null || touchedRef.current || hasStoredComposerPromptPresets()) return;
        writeComposerPromptPresets(snapshot);
        setPresets(snapshot);
      });
    }
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const openAdd = () => {
    setEditingIndex(null);
    setDraft(EMPTY_PROMPT_PRESET_DRAFT);
    setError(null);
    setFormOpen(true);
  };

  const openEdit = (index: number) => {
    const preset = presets[index];
    if (!preset) return;
    setEditingIndex(index);
    setDraft({ prompt: preset });
    setError(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingIndex(null);
    setDraft(EMPTY_PROMPT_PRESET_DRAFT);
    setError(null);
  };

  const save = () => {
    const prompt = draft.prompt.trim();
    if (!prompt) {
      setError("送信プロンプトを入力してください");
      return;
    }
    if (prompt.length > MAX_COMPOSER_PROMPT_PRESET_PROMPT_CHARS) {
      setError(`送信プロンプトは${MAX_COMPOSER_PROMPT_PRESET_PROMPT_CHARS}文字以内で入力してください`);
      return;
    }
    if (presets.some((preset, index) => index !== editingIndex && preset === prompt)) {
      setError("同じ本文のプリセットは登録できません");
      return;
    }
    if (editingIndex === null && presets.length >= MAX_COMPOSER_PROMPT_PRESETS) {
      setError(`プリセットは${MAX_COMPOSER_PROMPT_PRESETS}件まで登録できます`);
      return;
    }
    const next = [...presets];
    if (editingIndex === null) next.push(prompt);
    else next[editingIndex] = prompt;
    if (JSON.stringify(next).length > MAX_COMPOSER_PROMPT_PRESETS_VALUE_CHARS) {
      setError("プリセット全体が大きすぎます。本文を短くしてください");
      return;
    }
    writeComposerPromptPresets(next);
    setPresets(next);
    closeForm();
  };

  const remove = (index: number) => {
    if (!presets[index]) return;
    const next = presets.filter((_, itemIndex) => itemIndex !== index);
    writeComposerPromptPresets(next);
    setPresets(next);
    if (editingIndex === index) closeForm();
    else if (editingIndex !== null && editingIndex > index) setEditingIndex(editingIndex - 1);
  };

  return (
    <section aria-labelledby="composer-prompt-presets-heading" className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="composer-prompt-presets-heading" className="text-sm font-semibold">送信プロンプト</h3>
          <p className="mt-1 text-xs text-muted">よく使う指示を <code className="rounded bg-surface-2 px-1">#</code> で呼び出せます。</p>
        </div>
        {!formOpen && (
          <button
            type="button"
            onClick={openAdd}
            disabled={presets.length >= MAX_COMPOSER_PROMPT_PRESETS}
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-accent hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            プリセットを追加
          </button>
        )}
      </div>
      {presets.length > 0 && (
        <ul aria-label="送信プロンプトのプリセット" className="mt-3 divide-y divide-border rounded-xl border border-border">
          {presets.map((preset, index) => (
            <li key={index} className="flex items-start gap-3 px-3 py-3 first:rounded-t-xl last:rounded-b-xl">
              <p className="min-w-0 flex-1 line-clamp-3 whitespace-pre-wrap text-sm">{preset}</p>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" aria-label={`${index + 1}番目のプリセットを編集`} onClick={() => openEdit(index)} className="rounded-lg px-2 py-1 text-xs text-accent hover:bg-surface-2">編集</button>
                <button type="button" aria-label={`${index + 1}番目のプリセットを削除`} onClick={() => remove(index)} className="rounded-lg px-2 py-1 text-xs text-danger hover:bg-danger/5">削除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {formOpen && (
        <form
          className="mt-3 space-y-3 rounded-xl border border-accent/30 bg-surface-2 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <p className="text-xs font-medium">{editingIndex === null ? "プリセットを追加" : "プリセットを編集"}</p>
          <label className="block text-sm">
            <span className="font-medium">送信する本文</span>
            <textarea
              aria-label="送信プロンプト本文"
              value={draft.prompt}
              maxLength={MAX_COMPOSER_PROMPT_PRESET_PROMPT_CHARS}
              onChange={(event) => setDraft({ prompt: event.target.value })}
              placeholder="例: 変更内容をレビューし、問題点と改善案を箇条書きで示してください。"
              rows={4}
              className="mt-1 w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-sm leading-5 outline-none focus:border-accent"
              autoFocus
            />
          </label>
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeForm} className="rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-bg">キャンセル</button>
            <button type="submit" className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90">保存</button>
          </div>
        </form>
      )}
    </section>
  );
}
