"use client";

import { useCallback, useMemo } from "react";
import { ChevronDown, ChevronUp, Plus, RotateCcw, X } from "lucide-react";
import { IntelligenceSelect } from "@/components/IntelligenceSelect";
import { ModelSelect } from "@/components/ModelSelect";
import { Button } from "@/components/ui";
import {
  AUTO_OPTIMIZE_MODES,
  autoOptimizeModeLabel,
  chooseAutoModel,
  isAutoRouteConfigEmpty,
  MAX_AUTO_ROUTE_CANDIDATES,
  normalizeAutoRouteConfig,
  presetTierRoute,
  type AutoModeRoute,
  type AutoOptimizeMode,
  type AutoRouteCandidate,
  type AutoRouteConfig,
  type AutoTier,
  type AutoTierFallback,
  type AutoTierRoute,
  type ModelCostTier,
} from "@/lib/auto-model";
import {
  ALL_INTELLIGENCE_VARIANTS,
  getIntelligenceVariants,
  isIntelligenceVariant,
  type IntelligenceVariant,
} from "@/lib/model-variants";
import type { ModelOption, ThinkingLevel } from "@/lib/types";

const TIERS: readonly AutoTier[] = ["light", "standard", "heavy"];
const TIER_LABEL: Record<AutoTier, string> = {
  light: "ライト",
  standard: "標準",
  heavy: "ヘビー",
};
const TIER_DESCRIPTION: Record<AutoTier, string> = {
  light: "短い質問・雑談",
  standard: "一般的なコーディング",
  heavy: "大規模リファクタ・設計",
};
const COST_TIERS: readonly ModelCostTier[] = ["cheap", "mid", "premium"];
const COST_LABEL: Record<ModelCostTier, string> = {
  cheap: "低コスト",
  mid: "中コスト",
  premium: "高コスト",
};
const FALLBACK_LABEL: Record<AutoTierFallback, string> = {
  preset: "プリセットに従う",
  strongest: "最強候補にフォールバック",
  error: "エラーにする",
};
const FALLBACKS: readonly AutoTierFallback[] = ["preset", "strongest", "error"];

const VARIANT_LABEL: Record<IntelligenceVariant, string> = {
  none: "なし",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
  thinking: "思考",
};

export type AutoRouteProviders = readonly {
  id: string;
  name: string;
  enabled: boolean;
  models: readonly {
    id: string;
    name: string;
    enabled: boolean;
    variants?: Record<string, { disabled?: boolean } | undefined>;
  }[];
}[];

type AutoRouteSource = AutoRouteProviders | readonly ModelOption[];

function isProviderSource(source: AutoRouteSource): source is AutoRouteProviders {
  return source.length > 0 && "models" in source[0]!;
}

function modelOptionsFromProviders(providers: AutoRouteProviders): ModelOption[] {
  return providers.flatMap((provider) =>
    provider.enabled
      ? provider.models.filter((model) => model.enabled).map((model) => ({
          value: `${provider.id}::${model.id}`,
          label: model.name,
          providerID: provider.id,
          modelID: model.id,
          thinkingLevels: getIntelligenceVariants(model) as unknown as ThinkingLevel[],
        }))
      : [],
  );
}

/** Connected and enabled model options, excluding the Auto pseudo-option. */
export function autoRouteModelOptions(source: AutoRouteSource): ModelOption[] {
  const models = isProviderSource(source) ? modelOptionsFromProviders(source) : source;
  const seen = new Set<string>();
  return models.filter((model) => {
    if (model.value === "auto") return false;
    const value = `${model.providerID}::${model.modelID}`;
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  }).map((model) => ({
    ...model,
    value: `${model.providerID}::${model.modelID}`,
    accountId: undefined,
    accountLabel: undefined,
  }));
}

function modelVariantsFor(
  source: AutoRouteSource,
  providerID: string,
  modelID: string,
): IntelligenceVariant[] {
  if (isProviderSource(source)) {
    const model = source
      .find((provider) => provider.id === providerID)
      ?.models.find((candidate) => candidate.id === modelID);
    return getIntelligenceVariants(model);
  }
  const model = source.find(
    (candidate) => candidate.providerID === providerID && candidate.modelID === modelID,
  );
  return (model?.thinkingLevels ?? []).filter(isIntelligenceVariant) as unknown as IntelligenceVariant[];
}

function effortOptionsFor(
  candidate: AutoRouteCandidate,
  source: AutoRouteSource,
): IntelligenceVariant[] {
  return candidate.kind === "model"
    ? modelVariantsFor(source, candidate.providerID, candidate.modelID)
    : [...ALL_INTELLIGENCE_VARIANTS];
}

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(to, 0, item);
  return next;
}

function cellMatchesPreset(
  mode: AutoOptimizeMode,
  tier: AutoTier,
  cell: AutoTierRoute | undefined,
): boolean {
  return !cell || JSON.stringify(cell) === JSON.stringify(presetTierRoute(mode, tier));
}

function ResolutionPreview({
  mode,
  tier,
  config,
  models,
}: {
  mode: AutoOptimizeMode;
  tier: AutoTier;
  config: AutoRouteConfig;
  models: readonly ModelOption[];
}) {
  const preview = useMemo(
    () =>
      chooseAutoModel({
        models,
        tier,
        mode,
        hasImages: false,
        config,
      }),
    [config, mode, models, tier],
  );
  if (!preview) {
    return <p className="text-xs text-danger">解決できません（候補が全て未接続です）</p>;
  }
  return (
    <p className="text-xs text-muted">
      現在の解決結果: {preview.modelID}
      {preview.variant
        ? ` / ${isIntelligenceVariant(preview.variant) ? VARIANT_LABEL[preview.variant] : preview.variant}`
        : ""}
    </p>
  );
}

function CandidateRow({
  index,
  isLast,
  candidate,
  source,
  modelOptions,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  isLast: boolean;
  candidate: AutoRouteCandidate;
  source: AutoRouteSource;
  modelOptions: ModelOption[];
  onChange: (candidate: AutoRouteCandidate) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const effortOptions = effortOptionsFor(candidate, source);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5">
      <span className="w-4 shrink-0 text-right text-[10px] text-faint">{index + 1}.</span>
      {candidate.kind === "model" && (
        <ModelSelect
          value={`${candidate.providerID}::${candidate.modelID}`}
          options={modelOptions}
          ariaLabel={`候補${index + 1}のモデル`}
          emptyLabel="モデルなし"
          onChange={(value) => {
            const selected = modelOptions.find((option) => option.value === value);
            if (!selected) return;
            onChange({
              ...candidate,
              providerID: selected.providerID,
              modelID: selected.modelID,
              variant: undefined,
            });
          }}
          className="min-w-0 flex-1"
        />
      )}
      {candidate.kind === "cost" && (
        <select
          aria-label={`候補${index + 1}のコスト帯`}
          value={candidate.cost}
          onChange={(event) =>
            onChange({ ...candidate, cost: event.target.value as ModelCostTier })
          }
          className="h-7 min-w-0 flex-1 rounded border border-border bg-surface px-1.5 text-xs text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
        >
          {COST_TIERS.map((cost) => (
            <option key={cost} value={cost}>{COST_LABEL[cost]}</option>
          ))}
        </select>
      )}
      {candidate.kind === "strongest" && (
        <span className="flex-1 text-xs text-muted">最強候補を優先</span>
      )}
      {effortOptions.length > 0 && (
        <IntelligenceSelect
          variants={effortOptions}
          value={candidate.variant ?? ""}
          onChange={(value) =>
            onChange({
              ...candidate,
              ...(isIntelligenceVariant(value) ? { variant: value } : { variant: undefined }),
            })
          }
          ariaLabel={`候補${index + 1}のeffort`}
          className="h-7 shrink-0"
        />
      )}
      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          aria-label={`候補${index + 1}を上へ`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
          className="inline-flex h-11 w-11 items-center justify-center rounded text-faint hover:bg-surface-3 hover:text-muted disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary sm:h-6 sm:w-6"
        >
          <ChevronUp aria-hidden="true" className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={`候補${index + 1}を下へ`}
          disabled={isLast}
          onClick={() => onMove(1)}
          className="inline-flex h-11 w-11 items-center justify-center rounded text-faint hover:bg-surface-3 hover:text-muted disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary sm:h-6 sm:w-6"
        >
          <ChevronDown aria-hidden="true" className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={`候補${index + 1}を削除`}
          onClick={onRemove}
          className="inline-flex h-11 w-11 items-center justify-center rounded text-faint hover:bg-surface-3 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary sm:h-6 sm:w-6"
        >
          <X aria-hidden="true" className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function TierEditor({
  mode,
  tier,
  config,
  source,
  modelOptions,
  onChange,
}: {
  mode: AutoOptimizeMode;
  tier: AutoTier;
  config: AutoRouteConfig;
  source: AutoRouteSource;
  modelOptions: ModelOption[];
  onChange: (config: AutoRouteConfig) => void;
}) {
  const cell = config.modes[mode]?.[tier];
  const candidates = useMemo(() => cell?.candidates ?? [], [cell]);
  const isPreset = cellMatchesPreset(mode, tier, cell);

  const setCell = useCallback(
    (nextCell: AutoTierRoute | undefined) => {
      const modes = { ...config.modes };
      const modeRoute: AutoModeRoute = { ...modes[mode] };
      if (!nextCell || cellMatchesPreset(mode, tier, nextCell)) delete modeRoute[tier];
      else modeRoute[tier] = nextCell;
      if (Object.keys(modeRoute).length === 0) delete modes[mode];
      else modes[mode] = modeRoute;
      onChange(normalizeAutoRouteConfig({ version: 2, modes }));
    },
    [config, mode, onChange, tier],
  );

  const setCandidates = useCallback(
    (nextCandidates: readonly AutoRouteCandidate[]) => {
      if (nextCandidates.length === 0) {
        setCell(undefined);
        return;
      }
      setCell({
        candidates: [...nextCandidates],
        ...(cell?.variantFallbackOrder
          ? { variantFallbackOrder: cell.variantFallbackOrder }
          : {}),
        ...(cell?.fallback ? { fallback: cell.fallback } : {}),
      });
    },
    [cell, setCell],
  );

  const addableOptions = useMemo(() => {
    const used = new Set(
      candidates.flatMap((candidate) =>
        candidate.kind === "model"
          ? [`${candidate.providerID}::${candidate.modelID}`]
          : [],
      ),
    );
    return modelOptions.filter((option) => !used.has(option.value));
  }, [candidates, modelOptions]);

  const handleAdd = () => {
    const option = addableOptions[0];
    if (!option || candidates.length >= MAX_AUTO_ROUTE_CANDIDATES) return;
    setCandidates([
      ...candidates,
      { kind: "model", providerID: option.providerID, modelID: option.modelID },
    ]);
  };

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-xs font-medium text-muted">
          {TIER_LABEL[tier]}
          <span className="ml-1.5 text-muted">{TIER_DESCRIPTION[tier]}</span>
        </p>
        {!isPreset && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${TIER_LABEL[tier]}をリセット`}
            onClick={() => setCell(undefined)}
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        )}
      </div>
      <p className="text-[10px] uppercase tracking-wide text-muted">候補（上が優先）</p>
      {candidates.length === 0 ? (
        <p className="text-xs text-muted">プリセットを使用中</p>
      ) : (
        <div className="space-y-1">
          {candidates.map((candidate, index) => (
            <CandidateRow
              key={`${index}-${candidate.kind}`}
              index={index}
              isLast={index === candidates.length - 1}
              candidate={candidate}
              source={source}
              modelOptions={modelOptions}
              onChange={(next) =>
                setCandidates(candidates.map((item, itemIndex) => itemIndex === index ? next : item))
              }
              onMove={(direction) => setCandidates(moveItem(candidates, index, index + direction))}
              onRemove={() => setCandidates(candidates.filter((_, itemIndex) => itemIndex !== index))}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={candidates.length >= MAX_AUTO_ROUTE_CANDIDATES || addableOptions.length === 0}
        onClick={handleAdd}
        className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted hover:bg-surface-3 hover:text-text disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
      >
        <Plus className="h-3 w-3" />
        候補を追加
      </button>
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-wide text-muted">全候補が使えない時</p>
        <select
          aria-label={`${TIER_LABEL[tier]}のフォールバック`}
          value={cell?.fallback ?? "preset"}
          disabled={candidates.length === 0}
          onChange={(event) =>
            setCell({
              candidates: [...candidates],
              ...(cell?.variantFallbackOrder
                ? { variantFallbackOrder: cell.variantFallbackOrder }
                : {}),
              fallback: event.target.value as AutoTierFallback,
            })
          }
          className="h-7 rounded border border-border bg-surface px-1.5 text-xs text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
        >
          {FALLBACKS.map((fallback) => (
            <option key={fallback} value={fallback}>{FALLBACK_LABEL[fallback]}</option>
          ))}
        </select>
      </div>
      <ResolutionPreview mode={mode} tier={tier} config={config} models={modelOptions} />
    </div>
  );
}

export function AutoRouteOverridesEditor({
  mode,
  config,
  models,
  providers,
  onChange,
}: {
  mode: AutoOptimizeMode;
  config: AutoRouteConfig;
  /** Enabled model options from `/api/models`. */
  models?: readonly ModelOption[];
  /** Compatibility input for callers that already have provider rows. */
  providers?: AutoRouteProviders;
  onChange: (next: AutoRouteConfig) => void;
}) {
  const source = useMemo<AutoRouteSource>(
    () => models ?? providers ?? [],
    [models, providers],
  );
  const modelOptions = useMemo(() => autoRouteModelOptions(source), [source]);
  const hasAnyOverride = !isAutoRouteConfigEmpty(config);

  const resetModeConfig = (targetMode: AutoOptimizeMode) => {
    const modes = { ...config.modes };
    delete modes[targetMode];
    onChange(normalizeAutoRouteConfig({ version: 2, modes }));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted">Auto ルーティング設定</p>
        {hasAnyOverride && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="全モードの設定をリセット"
            onClick={() => onChange(normalizeAutoRouteConfig({ version: 2, modes: {} }))}
          >
            <RotateCcw className="h-3 w-3" />
            全リセット
          </Button>
        )}
      </div>
      <div className="space-y-4 rounded-lg border border-border bg-surface-2 px-3 py-3">
        <p className="text-xs text-muted">
          各モードのtier設定を一覧で編集できます。*は現在の最適化方針です。未編集のtierはそのモードの初期値のまま動きます。
        </p>
        <div
          role="group"
          aria-label="Auto ルーティング設定一覧"
          className="grid grid-cols-3 gap-3"
        >
          {AUTO_OPTIMIZE_MODES.map((candidateMode) => {
            const hasModeOverride = TIERS.some(
              (tier) => !cellMatchesPreset(candidateMode, tier, config.modes[candidateMode]?.[tier]),
            );
            return (
              <div key={candidateMode} className="min-w-0 space-y-2 rounded-xl border border-border bg-surface p-2">
                <div className="flex min-h-9 items-center justify-between gap-1">
                  <p className="min-w-0 truncate text-xs font-semibold text-muted">
                    {autoOptimizeModeLabel(candidateMode)}
                    {candidateMode === mode && <span className="ml-1">*</span>}
                  </p>
                  {hasModeOverride && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${autoOptimizeModeLabel(candidateMode)}モードをリセット`}
                      onClick={() => resetModeConfig(candidateMode)}
                    >
                      <RotateCcw className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                {TIERS.map((tier) => (
                  <TierEditor
                    key={`${candidateMode}-${tier}`}
                    mode={candidateMode}
                    tier={tier}
                    config={config}
                    source={source}
                    modelOptions={modelOptions}
                    onChange={onChange}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
