"use client";

import { Brain } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ModelSelect, modelOptionForValue } from "@/components/ModelSelect";
import { Button, GhostSelect } from "@/components/ui";
import { ApiError, getJson } from "@/lib/client";
import {
  readGenerationFallbackModel,
  readGenerationFallbackModelEffort,
  readGenerationFallbackModelEffortFromServer,
  readGenerationFallbackModelFromServer,
  readGenerationModel,
  readGenerationModelEffort,
  readGenerationModelEffortFromServer,
  readGenerationModelFromServer,
  writeGenerationFallbackModel,
  writeGenerationFallbackModelEffort,
  writeGenerationFallbackModelEffortToServer,
  writeGenerationFallbackModelToServer,
  writeGenerationModel,
  writeGenerationModelEffort,
  writeGenerationModelEffortToServer,
  writeGenerationModelToServer,
} from "@/lib/generation-model";
import { THINKING_LEVEL_LABELS } from "@/lib/thinking-levels";
import type { ModelOption, ThinkingLevel } from "@/lib/types";

function GenerationEffortSelect({
  label,
  levels,
  value,
  disabled,
  onChange,
}: {
  label: string;
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
      aria-label={label}
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
  const [fallbackValue, setFallbackValue] = useState(
    () => readGenerationFallbackModel() ?? "",
  );
  const [fallbackEffort, setFallbackEffort] = useState(
    () => readGenerationFallbackModelEffort() ?? "",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const changedRef = useRef({
    value: false,
    effort: false,
    fallbackValue: false,
    fallbackEffort: false,
  });

  useEffect(() => {
    let cancelled = false;
    const modelRequest = getJson<{ models: ModelOption[] }>("/api/models");
    void modelRequest
      .then((result) => {
        if (cancelled) return;
        setModels(result.models);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "モデル一覧を取得できません");
        setLoading(false);
      });
    void Promise.allSettled([
      modelRequest,
      readGenerationModelFromServer(),
      readGenerationModelEffortFromServer(),
      readGenerationFallbackModelFromServer(),
      readGenerationFallbackModelEffortFromServer(),
    ]).then(([modelsResult, settingResult, effortResult, fallbackResult, fallbackEffortResult]) => {
      if (cancelled) return;
      if (modelsResult.status === "fulfilled") {
        const nextModels = modelsResult.value.models;
        const serverValue = settingResult.status === "fulfilled" ? settingResult.value : null;
        const localValue = readGenerationModel();
        const nextValue =
          modelOptionForValue(nextModels, serverValue)?.value ??
          modelOptionForValue(nextModels, localValue)?.value ??
          "";
        const serverEffort = effortResult.status === "fulfilled" ? effortResult.value : null;
        const localEffort = readGenerationModelEffort();
        const nextEffort = serverEffort ?? localEffort ?? "";
        const serverFallbackValue = fallbackResult.status === "fulfilled" ? fallbackResult.value : null;
        const localFallbackValue = readGenerationFallbackModel();
        const nextFallbackValue =
          modelOptionForValue(nextModels, serverFallbackValue)?.value ??
          modelOptionForValue(nextModels, localFallbackValue)?.value ??
          "";
        const serverFallbackEffort = fallbackEffortResult.status === "fulfilled" ? fallbackEffortResult.value : null;
        const localFallbackEffort = readGenerationFallbackModelEffort();
        const nextFallbackEffort = serverFallbackEffort ?? localFallbackEffort ?? "";
        if (!changedRef.current.value) {
          setValue(nextValue);
          writeGenerationModel(nextValue || null);
        }
        if (!changedRef.current.effort) {
          setEffort(nextEffort);
          writeGenerationModelEffort(nextEffort || null);
        }
        if (!changedRef.current.fallbackValue) {
          setFallbackValue(nextFallbackValue);
          writeGenerationFallbackModel(nextFallbackValue || null);
        }
        if (!changedRef.current.fallbackEffort) {
          setFallbackEffort(nextFallbackEffort);
          writeGenerationFallbackModelEffort(nextFallbackEffort || null);
        }
        if (
          !changedRef.current.value &&
          serverValue &&
          nextValue &&
          serverValue !== nextValue &&
          modelOptionForValue(nextModels, serverValue)?.routingMode === "integrated"
        ) {
          void writeGenerationModelToServer(nextValue).catch(() => {
            if (!cancelled) setError("生成モデル設定の移行に失敗しました");
          });
        }
        if (
          !changedRef.current.fallbackValue &&
          serverFallbackValue &&
          nextFallbackValue &&
          serverFallbackValue !== nextFallbackValue &&
          modelOptionForValue(nextModels, serverFallbackValue)?.routingMode === "integrated"
        ) {
          void writeGenerationFallbackModelToServer(nextFallbackValue).catch(() => {
            if (!cancelled) setError("フォールバック設定の移行に失敗しました");
          });
        }
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

  const selected = useMemo(() => modelOptionForValue(models, value), [models, value]);
  const fallbackSelected = useMemo(
    () => modelOptionForValue(models, fallbackValue),
    [fallbackValue, models],
  );

  useEffect(() => {
    if (loading || !value || !selected || !effort) return;
    if ((selected.thinkingLevels ?? []).includes(effort as ThinkingLevel)) return;
    changedRef.current.effort = true;
    setEffort("");
    writeGenerationModelEffort(null);
    void writeGenerationModelEffortToServer(null).catch(() => undefined);
  }, [effort, loading, selected, value]);

  useEffect(() => {
    if (loading || !fallbackValue || !fallbackSelected || !fallbackEffort) return;
    if ((fallbackSelected.thinkingLevels ?? []).includes(fallbackEffort as ThinkingLevel)) return;
    changedRef.current.fallbackEffort = true;
    setFallbackEffort("");
    writeGenerationFallbackModelEffort(null);
    void writeGenerationFallbackModelEffortToServer(null).catch(() => undefined);
  }, [fallbackEffort, fallbackSelected, fallbackValue, loading]);

  function change(next: string) {
    changedRef.current.value = true;
    setValue(next);
    writeGenerationModel(next || null);
    void writeGenerationModelToServer(next || null).catch(() => {
      setError("生成モデルの保存に失敗しました");
    });
  }

  function changeEffort(next: string) {
    changedRef.current.effort = true;
    setEffort(next);
    writeGenerationModelEffort(next || null);
    void writeGenerationModelEffortToServer(next || null).catch(() => {
      setError("生成モデルのEffort保存に失敗しました");
    });
  }

  function changeFallback(next: string) {
    changedRef.current.fallbackValue = true;
    setFallbackValue(next);
    writeGenerationFallbackModel(next || null);
    void writeGenerationFallbackModelToServer(next || null).catch(() => {
      setError("フォールバック先の保存に失敗しました");
    });
  }

  function changeFallbackEffort(next: string) {
    changedRef.current.fallbackEffort = true;
    setFallbackEffort(next);
    writeGenerationFallbackModelEffort(next || null);
    void writeGenerationFallbackModelEffortToServer(next || null).catch(() => {
      setError("フォールバック先のEffort保存に失敗しました");
    });
  }

  return (
    <section aria-labelledby="generation-model-heading" className="rounded-2xl border border-border bg-surface p-4">
      <h2 id="generation-model-heading" className="text-sm font-semibold">生成モデル</h2>
      <p className="mt-1 text-xs text-muted">
        タイトル、NextAction、NextTask、コミットメッセージの提案に使うモデルです。未設定時は画面で選択したモデルを使います。認証済みのAPI・サブスク・ローカルプロバイダーを選択できます。
      </p>
      <div className="mt-3 space-y-3">
        <div>
          <p className="mb-1 text-xs font-medium text-muted">生成モデル</p>
          <div className="flex flex-wrap items-center gap-2">
            <ModelSelect
              value={value}
              options={models}
              disabled={loading}
              onChange={change}
              ariaLabel="生成モデル"
              className="min-w-0 flex-1 sm:min-w-64"
              title={selected?.label ?? "生成モデルを選択"}
            />
            {value && (
              <GenerationEffortSelect
                label="生成モデルのEffort"
                levels={selected?.thinkingLevels ?? []}
                value={effort}
                disabled={loading}
                onChange={changeEffort}
              />
            )}
            {value && <Button variant="ghost" size="sm" disabled={loading} onClick={() => change("")}>クリア</Button>}
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted">フォールバック先</p>
          <p className="mb-2 text-xs text-muted">
            未設定時、または生成に失敗したときに試すモデルです。対応モデルではEffortも指定できます。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ModelSelect
              value={fallbackValue}
              options={models}
              disabled={loading}
              onChange={changeFallback}
              ariaLabel="フォールバック先"
              className="min-w-0 flex-1 sm:min-w-64"
              title={fallbackSelected?.label ?? "フォールバック先を選択"}
            />
            {fallbackValue && (
              <GenerationEffortSelect
                label="フォールバック先のEffort"
                levels={fallbackSelected?.thinkingLevels ?? []}
                value={fallbackEffort}
                disabled={loading}
                onChange={changeFallbackEffort}
              />
            )}
            {fallbackValue && <Button variant="ghost" size="sm" disabled={loading} onClick={() => changeFallback("")}>クリア</Button>}
          </div>
        </div>
      </div>
      {loading && <p className="mt-2 text-xs text-muted">モデルを読み込み中…</p>}
      {models.length === 0 && !loading && <p className="mt-2 text-xs text-muted">利用可能なモデルがありません。</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
