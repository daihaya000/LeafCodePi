"use client";

import { Brain } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ModelSelect } from "@/components/ModelSelect";
import { Button, GhostSelect } from "@/components/ui";
import { ApiError, getJson } from "@/lib/client";
import {
  readGenerationModel,
  readGenerationModelEffort,
  readGenerationModelEffortFromServer,
  readGenerationModelFromServer,
  writeGenerationModel,
  writeGenerationModelEffort,
  writeGenerationModelEffortToServer,
  writeGenerationModelToServer,
} from "@/lib/generation-model";
import { THINKING_LEVEL_LABELS } from "@/lib/thinking-levels";
import type { ModelOption, ThinkingLevel } from "@/lib/types";

function GenerationEffortSelect({
  levels,
  value,
  disabled,
  onChange,
}: {
  levels: ThinkingLevel[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const options = levels.length <= 1 && levels[0] === "off" ? [] : levels;
  if (options.length === 0) return null;
  const effective = options.includes(value as ThinkingLevel) ? value : "";

  return (
    <GhostSelect
      value={effective}
      disabled={disabled}
      aria-label="生成モデルのEffort"
      icon={<Brain className="h-3.5 w-3.5" />}
      valueLabel={effective ? THINKING_LEVEL_LABELS[effective as ThinkingLevel] : "デフォルト"}
      onChange={onChange}
      className="h-9 shrink-0"
    >
      <option value="">デフォルト</option>
      {options.map((level) => (
        <option key={level} value={level}>
          {THINKING_LEVEL_LABELS[level]}
        </option>
      ))}
    </GhostSelect>
  );
}

export function GenerationModelSettings() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [value, setValue] = useState(() => readGenerationModel() ?? "");
  const [effort, setEffort] = useState(() => readGenerationModelEffort() ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      getJson<{ models: ModelOption[] }>("/api/models"),
      readGenerationModelFromServer(),
      readGenerationModelEffortFromServer(),
    ]).then(([modelsResult, settingResult, effortResult]) => {
      if (cancelled) return;
      if (modelsResult.status === "fulfilled") {
        const nextModels = modelsResult.value.models;
        setModels(nextModels);
        const serverValue = settingResult.status === "fulfilled" ? settingResult.value : null;
        const localValue = readGenerationModel();
        const nextValue = serverValue && nextModels.some((model) => model.value === serverValue)
          ? serverValue
          : localValue && nextModels.some((model) => model.value === localValue)
            ? localValue
            : "";
        const serverEffort = effortResult.status === "fulfilled" ? effortResult.value : null;
        const localEffort = readGenerationModelEffort();
        const nextEffort = serverEffort ?? localEffort ?? "";
        setValue(nextValue);
        setEffort(nextEffort);
        writeGenerationModel(nextValue || null);
        writeGenerationModelEffort(nextEffort || null);
        setError(null);
      } else {
        setError(modelsResult.reason instanceof ApiError ? modelsResult.reason.message : "モデル一覧を取得できません");
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(() => models.find((model) => model.value === value), [models, value]);

  useEffect(() => {
    if (loading || !value || !selected || !effort) return;
    if ((selected.thinkingLevels ?? []).includes(effort as ThinkingLevel)) return;
    setEffort("");
    writeGenerationModelEffort(null);
    void writeGenerationModelEffortToServer(null).catch(() => undefined);
  }, [effort, loading, selected, value]);

  function change(next: string) {
    setValue(next);
    writeGenerationModel(next || null);
    void writeGenerationModelToServer(next || null).catch(() => {
      setError("生成モデルの保存に失敗しました");
    });
  }

  function changeEffort(next: string) {
    setEffort(next);
    writeGenerationModelEffort(next || null);
    void writeGenerationModelEffortToServer(next || null).catch(() => {
      setError("生成モデルのEffort保存に失敗しました");
    });
  }

  return (
    <section aria-labelledby="generation-model-heading" className="rounded-2xl border border-border bg-surface p-4">
      <h2 id="generation-model-heading" className="text-sm font-semibold">生成モデル</h2>
      <p className="mt-1 text-xs text-muted">
        タイトル、NextAction、NextTask、コミットメッセージの提案に使うモデルです。未設定時は画面で選択したモデルを使います。認証済みのAPI・サブスク・ローカルプロバイダーを選択できます。対応モデルではEffortも指定できます。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ModelSelect
          value={value}
          options={models}
          disabled={loading}
          onChange={change}
          className="min-w-0 flex-1 sm:min-w-64"
          title={selected?.label ?? "生成モデルを選択"}
        />
        {value && (
          <GenerationEffortSelect
            levels={selected?.thinkingLevels ?? []}
            value={effort}
            disabled={loading}
            onChange={changeEffort}
          />
        )}
        {value && <Button variant="ghost" size="sm" disabled={loading} onClick={() => change("")}>クリア</Button>}
      </div>
      {loading && <p className="mt-2 text-xs text-muted">モデルを読み込み中…</p>}
      {models.length === 0 && !loading && <p className="mt-2 text-xs text-muted">利用可能なモデルがありません。</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
