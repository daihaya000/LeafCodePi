"use client";

import { useEffect, useMemo, useState } from "react";
import { ModelSelect } from "@/components/ModelSelect";
import { Button } from "@/components/ui";
import { ApiError, getJson } from "@/lib/client";
import {
  readGenerationModel,
  readGenerationModelFromServer,
  writeGenerationModel,
  writeGenerationModelToServer,
} from "@/lib/generation-model";
import { DIRECT_GENERATION_PROVIDER_IDS } from "@/lib/generation-model-key";
import type { ModelOption } from "@/lib/types";

export function GenerationModelSettings() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [value, setValue] = useState(() => readGenerationModel() ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      getJson<{ models: ModelOption[] }>("/api/models"),
      readGenerationModelFromServer(),
    ]).then(([modelsResult, settingResult]) => {
      if (cancelled) return;
      if (modelsResult.status === "fulfilled") {
        const nextModels = modelsResult.value.models.filter((model) =>
          (DIRECT_GENERATION_PROVIDER_IDS as readonly string[]).includes(model.providerID),
        );
        setModels(nextModels);
        const serverValue = settingResult.status === "fulfilled" ? settingResult.value : null;
        const localValue = readGenerationModel();
        const nextValue = serverValue && nextModels.some((model) => model.value === serverValue)
          ? serverValue
          : localValue && nextModels.some((model) => model.value === localValue)
            ? localValue
            : "";
        setValue(nextValue);
        writeGenerationModel(nextValue || null);
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

  function change(next: string) {
    setValue(next);
    writeGenerationModel(next || null);
    void writeGenerationModelToServer(next || null).catch(() => {
      setError("生成モデルの保存に失敗しました");
    });
  }

  return (
    <section aria-labelledby="generation-model-heading" className="rounded-2xl border border-border bg-surface p-4">
      <h2 id="generation-model-heading" className="text-sm font-semibold">タイトル / NextAction / NextTask 生成モデル</h2>
      <p className="mt-1 text-xs text-muted">
        タイトル、NextAction、NextTaskの提案に使うモデルです。未設定時は画面で選択したモデルを使います（llama-server / Ollama Cloud対応）。
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
        {value && <Button variant="ghost" size="sm" disabled={loading} onClick={() => change("")}>クリア</Button>}
      </div>
      {loading && <p className="mt-2 text-xs text-muted">モデルを読み込み中…</p>}
      {models.length === 0 && !loading && <p className="mt-2 text-xs text-muted">利用可能なモデルがありません。</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
