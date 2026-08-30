/**
 * Deterministic, coding-focused Auto model selection.
 *
 * This module is deliberately free of browser and Node-only dependencies so
 * the same classifier/selector can run in the API route and TaskView.
 */

import type { ModelOption, ThinkingLevel } from "@/lib/types";
import { modelIntelligenceScore } from "@/lib/model-options";
import {
  getIntelligenceVariants,
  isIntelligenceVariant,
  type IntelligenceVariant,
} from "@/lib/model-variants";

export const AUTO_MODEL_VALUE = "auto";

export const AUTO_MODEL_OPTION: ModelOption = {
  value: AUTO_MODEL_VALUE,
  label: "Auto（コスト最適）",
  providerID: AUTO_MODEL_VALUE,
  modelID: AUTO_MODEL_VALUE,
};

export type AutoTier = "light" | "standard" | "heavy";
export type ModelCostTier = "cheap" | "mid" | "premium";
export type AutoOptimizeMode = "cost" | "balanced" | "intelligence";

export const AUTO_OPTIMIZE_MODES: readonly AutoOptimizeMode[] = [
  "cost",
  "balanced",
  "intelligence",
];
export const DEFAULT_AUTO_OPTIMIZE_MODE: AutoOptimizeMode = "cost";

export function isAutoOptimizeMode(value: unknown): value is AutoOptimizeMode {
  return (
    typeof value === "string" &&
    (AUTO_OPTIMIZE_MODES as readonly string[]).includes(value)
  );
}

const AUTO_OPTIMIZE_MODE_LABEL: Record<AutoOptimizeMode, string> = {
  cost: "コスト優先",
  balanced: "バランス",
  intelligence: "知能優先",
};

export function autoOptimizeModeLabel(mode: AutoOptimizeMode): string {
  return AUTO_OPTIMIZE_MODE_LABEL[mode];
}

const TIER_LADDER: readonly AutoTier[] = ["light", "standard", "heavy"];

/** Legacy v1 route override shape kept for stored-setting migration. */
export type TierRouteOverride = {
  costOrder?: readonly ModelCostTier[] | null;
  variantOrder?: readonly IntelligenceVariant[];
};

export type RouteOverrides = Partial<Record<AutoTier, TierRouteOverride>>;

export const EMPTY_ROUTE_OVERRIDES: RouteOverrides = Object.freeze({});

export const AUTO_ROUTE_CONFIG_VERSION = 2 as const;

export type AutoRouteCandidate =
  | {
      kind: "model";
      providerID: string;
      modelID: string;
      variant?: IntelligenceVariant | "";
    }
  | { kind: "cost"; cost: ModelCostTier; variant?: IntelligenceVariant | "" }
  | { kind: "strongest"; variant?: IntelligenceVariant | "" };

export type AutoTierFallback = "preset" | "strongest" | "error";

export type AutoTierRoute = {
  readonly candidates: readonly AutoRouteCandidate[];
  readonly variantFallbackOrder?: readonly IntelligenceVariant[];
  readonly fallback?: AutoTierFallback;
};

export type AutoModeRoute = Partial<Record<AutoTier, AutoTierRoute>>;

export type AutoRouteConfig = {
  version: typeof AUTO_ROUTE_CONFIG_VERSION;
  modes: Partial<Record<AutoOptimizeMode, AutoModeRoute>>;
};

export const EMPTY_AUTO_ROUTE_CONFIG: AutoRouteConfig = Object.freeze({
  version: AUTO_ROUTE_CONFIG_VERSION,
  modes: Object.freeze({}),
});

export const MAX_AUTO_ROUTE_CANDIDATES = 8;

function isModelCostTier(value: unknown): value is ModelCostTier {
  return value === "cheap" || value === "mid" || value === "premium";
}

export function isAutoTierFallback(value: unknown): value is AutoTierFallback {
  return value === "preset" || value === "strongest" || value === "error";
}

function dedupeInOrder<T extends string>(
  entries: readonly unknown[],
  guard: (value: unknown) => value is T,
): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const entry of entries) {
    if (guard(entry) && !seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

function normalizeTierOverride(raw: unknown): TierRouteOverride | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  let costOrder: readonly ModelCostTier[] | null | undefined;
  if (obj.costOrder === null) {
    costOrder = null;
  } else if (Array.isArray(obj.costOrder)) {
    const ordered = dedupeInOrder(obj.costOrder, isModelCostTier);
    if (ordered.length > 0) costOrder = ordered;
  }
  let variantOrder: readonly IntelligenceVariant[] | undefined;
  if (Array.isArray(obj.variantOrder)) {
    const ordered = dedupeInOrder(obj.variantOrder, isIntelligenceVariant);
    if (ordered.length > 0) variantOrder = ordered;
  }
  if (costOrder === undefined && variantOrder === undefined) return undefined;
  return {
    ...(costOrder !== undefined ? { costOrder } : {}),
    ...(variantOrder ? { variantOrder } : {}),
  };
}

export function normalizeRouteOverrides(raw: unknown): RouteOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const object = raw as Record<string, unknown>;
  const result: RouteOverrides = {};
  for (const tier of TIER_LADDER) {
    const override = normalizeTierOverride(object[tier]);
    if (override) result[tier] = override;
  }
  return result;
}

export function isRouteOverridesEmpty(overrides: RouteOverrides): boolean {
  return Object.keys(overrides).length === 0;
}

/** Provider-shaped input kept compatible with the upstream LeafCode contract. */
export type AutoCandidateProvider = {
  id: string;
  models: Record<string, {
    name?: string;
    variants?: Record<string, { disabled?: boolean } | undefined>;
    capabilities?: {
      attachment?: boolean;
      input?: { image?: boolean };
    };
    accountId?: string;
  }>;
};

/** Optional CodexBar usage data used only as a routing hint. */
export type AutoProviderUsage = Record<
  string,
  { usedPercent: number | null; limited: boolean; stale?: boolean }
>;

export const AUTO_USAGE_REROUTE_GAP = 20;
const AUTO_USAGE_LIMIT_PERCENT = 90;

export type AutoProviderUsageSource = {
  id: string;
  accountId?: string | null;
  usedPercent?: number | null;
  limited?: boolean;
  maxed?: boolean;
  stale?: boolean;
};

function autoProviderUsageKey(providerID: string, accountId?: string): string {
  return accountId ? `${accountId}::${providerID}` : providerID;
}

function mergeAutoProviderUsage(
  usage: AutoProviderUsage,
  source: AutoProviderUsageSource,
): void {
  if (!source.id) return;
  const usedPercent =
    typeof source.usedPercent === "number" && Number.isFinite(source.usedPercent)
      ? source.usedPercent
      : null;
  const limited =
    source.limited === true ||
    source.maxed === true ||
    (usedPercent !== null && usedPercent >= AUTO_USAGE_LIMIT_PERCENT);
  if (usedPercent === null && !limited) return;
  const key = autoProviderUsageKey(source.id, source.accountId ?? undefined);
  const previous = usage[key];
  const mergedPercent =
    previous?.usedPercent == null
      ? usedPercent
      : usedPercent == null
        ? previous.usedPercent
        : Math.max(previous.usedPercent, usedPercent);
  const stale = Boolean(previous?.stale) || source.stale === true;
  usage[key] = {
    usedPercent: mergedPercent,
    limited: Boolean(previous?.limited) || limited,
    ...(stale ? { stale: true } : {}),
  };
}

/** Convert CodexBar provider rows into short-lived routing hints. */
export function autoProviderUsageFromProviders(
  providers: readonly AutoProviderUsageSource[],
): AutoProviderUsage {
  const usage: AutoProviderUsage = {};
  for (const provider of providers) mergeAutoProviderUsage(usage, provider);
  return usage;
}

/** Convert usage fields already attached to model options into routing hints. */
export function autoProviderUsageFromModels(
  models: readonly ModelOption[],
): AutoProviderUsage {
  return autoProviderUsageFromProviders(
    models.map((model) => ({
      id: model.providerID,
      accountId: model.accountId,
      usedPercent: model.codexbarUsedPercent,
      maxed: model.codexbarMaxed,
      stale: model.codexbarStale,
    })),
  );
}

export type AutoVariant = IntelligenceVariant | "off";

export type AutoDecision = {
  providerID: string;
  modelID: string;
  accountId?: string;
  variant: AutoVariant | "";
  tier: AutoTier;
  mode: AutoOptimizeMode;
  reason: string;
  candidateIndex?: number;
  usedPreset?: boolean;
  escalation?: {
    providerID: string;
    modelID: string;
    accountId?: string;
    variant: AutoVariant | "";
  };
};

export type AutoSignals = {
  hasImages: boolean;
  attachmentCount?: number;
  historyMessageCount?: number;
  recentFailure?: boolean;
};

const HEAVY_KEYWORD_RE =
  /リファクタ|再設計|作り直|移行|マイグレ|アーキテクチャ|全面|全体的|複数ファイル|横断|パフォーマンス改善|最適化|デッドロック|競合状態|refactor|redesign|migrat|architect|multi-?file|cross-?cutting|deadlock|race condition|optimi[sz]e/i;
const QUESTION_RE =
  /なぜ|何が|どこ|どうやって|どういう|とは|教えて|説明|意味|why|what|where|how|explain|mean/i;
const WORK_RE =
  /実装|修正|追加|作成|変更|書いて|直して|消して|削除|テスト書|fix|implement|add|create|write|update|delete|remove/i;
const FILE_PATH_RE =
  /[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|cpp|c|h|md|json|jsonc|ya?ml|toml|css|scss|html|sql|sh|bat|ps1)\b/gi;
const NUMBERED_ITEM_RE = /^[ \t]*\d+[.)][ \t]+\S/gm;

export const SIGNAL_FILE_PATH_THRESHOLD = 3;
export const SIGNAL_NUMBERED_LIST_THRESHOLD = 4;
export const SIGNAL_ATTACHMENT_THRESHOLD = 3;
export const SIGNAL_HISTORY_THRESHOLD = 20;

function countCodeFences(text: string): number {
  return text.match(/```/g)?.length ?? 0;
}

function countDistinctFilePaths(text: string): number {
  return new Set(
    [...text.matchAll(FILE_PATH_RE)].map((match) => match[0].toLowerCase()),
  ).size;
}

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

function bumpTier(tier: AutoTier): AutoTier {
  return tier === "light" ? "standard" : "heavy";
}

function classifyText(prompt: string): AutoTier {
  const text = prompt.trim();
  const fences = countCodeFences(text);
  if (text.length > 1_500) return "heavy";
  if (fences >= 4) return "heavy";
  if (HEAVY_KEYWORD_RE.test(text)) return "heavy";
  if (countDistinctFilePaths(text) >= SIGNAL_FILE_PATH_THRESHOLD) return "heavy";
  if (countMatches(text, NUMBERED_ITEM_RE) >= SIGNAL_NUMBERED_LIST_THRESHOLD) {
    return "heavy";
  }
  if (
    text.length < 200 &&
    fences === 0 &&
    QUESTION_RE.test(text) &&
    !WORK_RE.test(text)
  ) {
    return "light";
  }
  return "standard";
}

export function classifyPrompt(
  prompt: string,
  signals: AutoSignals = { hasImages: false },
): AutoTier {
  const base = classifyText(prompt);
  return signals.recentFailure === true ||
    (signals.attachmentCount ?? 0) >= SIGNAL_ATTACHMENT_THRESHOLD ||
    (signals.historyMessageCount ?? 0) >= SIGNAL_HISTORY_THRESHOLD
    ? bumpTier(base)
    : base;
}

const CHEAP_RE = /flash|mini|nano|lite|haiku|\bfast\b/;
const PREMIUM_RE = /fable|opus|ultra|\bsol\b/;

export function modelCostTier(modelID: string): ModelCostTier {
  const id = modelID.toLowerCase().replaceAll("_", "-");
  if (CHEAP_RE.test(id)) return "cheap";
  if (PREMIUM_RE.test(id)) return "premium";
  return "mid";
}

const MODE_COST_ORDER: Record<
  AutoOptimizeMode,
  Record<AutoTier, ModelCostTier[] | null>
> = {
  cost: {
    light: ["cheap", "mid", "premium"],
    standard: ["cheap", "mid", "premium"],
    heavy: null,
  },
  balanced: {
    light: ["cheap", "mid", "premium"],
    standard: ["mid", "premium", "cheap"],
    heavy: null,
  },
  intelligence: {
    light: ["mid", "cheap", "premium"],
    standard: ["premium", "mid", "cheap"],
    heavy: null,
  },
};

const MODE_VARIANT_ORDER: Record<
  AutoOptimizeMode,
  Record<AutoTier, readonly IntelligenceVariant[]>
> = {
  cost: {
    light: ["minimal", "none", "low"],
    standard: ["low", "minimal", "none", "medium"],
    heavy: ["medium", "high", "low"],
  },
  balanced: {
    light: ["low", "minimal", "none", "medium"],
    standard: ["medium", "low", "high", "minimal", "none"],
    heavy: ["high", "medium", "max", "low"],
  },
  intelligence: {
    light: ["medium", "low", "high", "minimal", "none"],
    standard: ["high", "medium", "max", "low"],
    heavy: ["max", "high", "medium"],
  },
};

const ESCALATION_VARIANT_ORDER: readonly AutoVariant[] = [
  "high",
  "max",
  "medium",
  "low",
  "minimal",
];

/** The one source of truth used by both the resolver and the settings UI. */
export function presetTierRoute(
  mode: AutoOptimizeMode,
  tier: AutoTier,
): AutoTierRoute {
  const costOrder = MODE_COST_ORDER[mode][tier];
  const candidates: AutoRouteCandidate[] =
    costOrder === null
      ? [{ kind: "strongest" }]
      : costOrder.map((cost) => ({ kind: "cost", cost }));
  return Object.freeze({
    candidates: Object.freeze(candidates),
    variantFallbackOrder: Object.freeze([...MODE_VARIANT_ORDER[mode][tier]]),
  });
}

function candidateKey(candidate: AutoRouteCandidate): string {
  const variant = candidate.variant ?? "*";
  switch (candidate.kind) {
    case "model":
      return `model:${candidate.providerID}::${candidate.modelID}::${variant}`;
    case "cost":
      return `cost:${candidate.cost}::${variant}`;
    case "strongest":
      return `strongest:${variant}`;
  }
}

function normalizeCandidate(raw: unknown): AutoRouteCandidate | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const object = raw as Record<string, unknown>;
  let variant: IntelligenceVariant | "" | undefined;
  if (object.variant === "") {
    variant = "";
  } else if (object.variant === undefined || isIntelligenceVariant(object.variant)) {
    variant = object.variant as IntelligenceVariant | undefined;
  } else {
    return undefined;
  }
  if (object.kind === "model") {
    if (
      typeof object.providerID !== "string" ||
      object.providerID.length === 0 ||
      object.providerID.includes("::") ||
      typeof object.modelID !== "string" ||
      object.modelID.length === 0
    ) {
      return undefined;
    }
    return variant === undefined
      ? { kind: "model", providerID: object.providerID, modelID: object.modelID }
      : { kind: "model", providerID: object.providerID, modelID: object.modelID, variant };
  }
  if (object.kind === "cost" && isModelCostTier(object.cost)) {
    return variant === undefined
      ? { kind: "cost", cost: object.cost }
      : { kind: "cost", cost: object.cost, variant };
  }
  if (object.kind === "strongest") {
    return variant === undefined
      ? { kind: "strongest" }
      : { kind: "strongest", variant };
  }
  return undefined;
}

function normalizeTierRoute(raw: unknown): AutoTierRoute | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const object = raw as Record<string, unknown>;
  const candidates: AutoRouteCandidate[] = [];
  const seen = new Set<string>();
  if (Array.isArray(object.candidates)) {
    for (const entry of object.candidates) {
      if (candidates.length >= MAX_AUTO_ROUTE_CANDIDATES) break;
      const candidate = normalizeCandidate(entry);
      if (!candidate || seen.has(candidateKey(candidate))) continue;
      seen.add(candidateKey(candidate));
      candidates.push(candidate);
    }
  }
  let variantFallbackOrder: readonly IntelligenceVariant[] | undefined;
  if (Array.isArray(object.variantFallbackOrder)) {
    const ordered = dedupeInOrder(object.variantFallbackOrder, isIntelligenceVariant);
    if (ordered.length > 0) variantFallbackOrder = ordered;
  }
  const fallback = isAutoTierFallback(object.fallback) ? object.fallback : undefined;
  if (candidates.length === 0 && !variantFallbackOrder) return undefined;
  return {
    candidates,
    ...(variantFallbackOrder ? { variantFallbackOrder } : {}),
    ...(fallback ? { fallback } : {}),
  };
}

function normalizeV2Config(raw: Record<string, unknown>): AutoRouteConfig {
  if (!raw.modes || typeof raw.modes !== "object" || Array.isArray(raw.modes)) {
    return EMPTY_AUTO_ROUTE_CONFIG;
  }
  const modesObject = raw.modes as Record<string, unknown>;
  const modes: AutoRouteConfig["modes"] = {};
  for (const mode of AUTO_OPTIMIZE_MODES) {
    const modeValue = modesObject[mode];
    if (!modeValue || typeof modeValue !== "object" || Array.isArray(modeValue)) continue;
    const route: AutoModeRoute = {};
    const routeObject = modeValue as Record<string, unknown>;
    for (const tier of TIER_LADDER) {
      const cell = normalizeTierRoute(routeObject[tier]);
      if (cell) route[tier] = cell;
    }
    if (Object.keys(route).length > 0) modes[mode] = route;
  }
  return Object.keys(modes).length > 0
    ? { version: AUTO_ROUTE_CONFIG_VERSION, modes }
    : EMPTY_AUTO_ROUTE_CONFIG;
}

function legacyRouteToTierRoute(override: TierRouteOverride): AutoTierRoute {
  const candidates: AutoRouteCandidate[] =
    override.costOrder === null
      ? [{ kind: "strongest" }]
      : (override.costOrder ?? []).map((cost) => ({ kind: "cost", cost }));
  return {
    candidates,
    ...(override.variantOrder
      ? { variantFallbackOrder: [...override.variantOrder] }
      : {}),
  };
}

function migrateV1Config(raw: Record<string, unknown>): AutoRouteConfig {
  const perTier: Partial<Record<AutoTier, AutoTierRoute>> = {};
  for (const tier of TIER_LADDER) {
    const override = normalizeTierOverride(raw[tier]);
    if (override) perTier[tier] = legacyRouteToTierRoute(override);
  }
  if (Object.keys(perTier).length === 0) return EMPTY_AUTO_ROUTE_CONFIG;
  const modes: AutoRouteConfig["modes"] = {};
  for (const mode of AUTO_OPTIMIZE_MODES) modes[mode] = { ...perTier };
  return { version: AUTO_ROUTE_CONFIG_VERSION, modes };
}

export function normalizeAutoRouteConfig(raw: unknown): AutoRouteConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return EMPTY_AUTO_ROUTE_CONFIG;
  }
  const object = raw as Record<string, unknown>;
  return object.version === AUTO_ROUTE_CONFIG_VERSION
    ? normalizeV2Config(object)
    : migrateV1Config(object);
}

export function isAutoRouteConfigEmpty(config: AutoRouteConfig): boolean {
  return Object.keys(config.modes).length === 0;
}

const TIER_LABEL: Record<AutoTier, string> = {
  light: "短い質問タスク",
  standard: "標準的なコーディングタスク",
  heavy: "大規模・高難度タスク",
};

function supportsImages(model: AutoCandidateProvider["models"][string]): boolean {
  return model.capabilities?.input?.image === true || model.capabilities?.attachment === true;
}

type Candidate = {
  providerID: string;
  modelID: string;
  accountId?: string;
  key: string;
  cost: ModelCostTier;
  score: number;
  variants: AutoVariant[];
  image: boolean;
  model: AutoCandidateProvider["models"][string];
};

function usageForCandidate(
  candidate: Candidate,
  usage: AutoProviderUsage | undefined,
): AutoProviderUsage[string] | undefined {
  if (!usage) return undefined;
  return (
    (candidate.accountId
      ? usage[autoProviderUsageKey(candidate.providerID, candidate.accountId)]
      : undefined) ?? usage[candidate.providerID]
  );
}

function variantsFromOption(option: ModelOption): AutoVariant[] {
  return (option.thinkingLevels ?? []).map((level) => level as AutoVariant);
}

function variantsFromProvider(
  model: AutoCandidateProvider["models"][string],
): AutoVariant[] {
  return getIntelligenceVariants(model);
}

function better(a: Candidate, b: Candidate): boolean {
  return a.score > b.score || (a.score === b.score && a.key < b.key);
}

function pickBest(
  candidates: Candidate[],
  usage?: AutoProviderUsage,
): Candidate | undefined {
  const eligible = usage
    ? candidates.filter((candidate) => {
        const hint = usageForCandidate(candidate, usage);
        return !hint?.limited || hint.stale === true;
      })
    : candidates;
  if (eligible.length === 0) return undefined;

  const normalBest = eligible.reduce<Candidate | undefined>(
    (best, candidate) => (!best || better(candidate, best) ? candidate : best),
    undefined,
  );
  if (!normalBest || !usage) return normalBest;

  const normalHint = usageForCandidate(normalBest, usage);
  const normalUsage =
    normalHint?.stale === true ? null : normalHint?.usedPercent ?? null;
  if (normalUsage === null) return normalBest;

  const knownUsage = eligible.filter(
    (candidate) => {
      const hint = usageForCandidate(candidate, usage);
      return hint?.stale !== true && hint?.usedPercent != null;
    },
  );
  const lowestUsage = knownUsage.reduce<number | null>((lowest, candidate) => {
    const value = usageForCandidate(candidate, usage)?.usedPercent ?? null;
    return value === null || (lowest !== null && value >= lowest)
      ? lowest
      : value;
  }, null);
  const usagePreferred =
    lowestUsage !== null && normalUsage - lowestUsage >= AUTO_USAGE_REROUTE_GAP
      ? knownUsage.filter(
          (candidate) => usageForCandidate(candidate, usage)?.usedPercent === lowestUsage,
        )
      : eligible;
  return usagePreferred.reduce<Candidate | undefined>(
    (best, candidate) => (!best || better(candidate, best) ? candidate : best),
    undefined,
  );
}

function pickVariant(
  candidate: Candidate,
  order: readonly AutoVariant[],
): AutoVariant | "" {
  for (const variant of order) {
    if (candidate.variants.includes(variant)) return variant;
  }
  return "";
}

function pickModelVariant(
  model: AutoCandidateProvider["models"][string],
  order: readonly IntelligenceVariant[],
): IntelligenceVariant | "" {
  const available = new Set(getIntelligenceVariants(model));
  return order.find((variant) => available.has(variant)) ?? "";
}

function candidatesFromInput(input: {
  models?: readonly ModelOption[];
  providers?: readonly AutoCandidateProvider[];
  connected?: readonly string[];
  disabled: Record<string, true>;
  hasImages: boolean;
}): Candidate[] {
  const connected = input.connected === undefined ? null : new Set(input.connected);
  const candidates: Candidate[] = [];
  const push = (
    providerID: string,
    modelID: string,
    model: AutoCandidateProvider["models"][string],
    accountId?: string,
    variants = variantsFromProvider(model),
  ) => {
    if (!providerID || !modelID || providerID === AUTO_MODEL_VALUE) return;
    if (connected && !connected.has(providerID)) return;
    if (
      input.disabled[providerID] ||
      input.disabled[`${providerID}::${modelID}`] ||
      (accountId && input.disabled[`${accountId}::${providerID}::${modelID}`])
    ) {
      return;
    }
    if (input.hasImages && !supportsImages(model)) return;
    candidates.push({
      providerID,
      modelID,
      ...(accountId ? { accountId } : {}),
      key: `${providerID}::${modelID}${accountId ? `::${accountId}` : ""}`,
      cost: modelCostTier(modelID),
      score: modelIntelligenceScore(modelID),
      variants,
      image: supportsImages(model),
      model,
    });
  };

  if (input.models) {
    for (const option of input.models) {
      if (option.value === AUTO_MODEL_VALUE) continue;
      const model = {
        variants: Object.fromEntries(
          (option.thinkingLevels ?? []).map((level) => [
            level === "off" ? "off" : level,
            {},
          ]),
        ),
        capabilities: { input: { image: option.input?.includes("image") === true } },
      };
      push(
        option.providerID,
        option.modelID,
        model,
        option.accountId,
        variantsFromOption(option),
      );
    }
  } else {
    for (const provider of input.providers ?? []) {
      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        push(provider.id, modelID, model, model.accountId);
      }
    }
  }
  return candidates;
}

function resolveCandidate(
  pool: Candidate[],
  candidate: AutoRouteCandidate,
  usage?: AutoProviderUsage,
): Candidate | undefined {
  if (candidate.kind === "model") {
    const matches = pool.filter(
      (item) =>
        item.providerID === candidate.providerID &&
        item.modelID === candidate.modelID,
    );
    return matches.length > 0 ? pickBest(matches, usage) : undefined;
  }
  if (candidate.kind === "cost") {
    return pickBest(pool.filter((item) => item.cost === candidate.cost), usage);
  }
  return pickBest(pool, usage);
}

function resolveCandidateVariant(
  model: AutoCandidateProvider["models"][string],
  candidate: AutoRouteCandidate,
  fallbackOrder: readonly IntelligenceVariant[],
): AutoVariant | "" {
  if (candidate.variant === "") return "";
  const available = new Set(getIntelligenceVariants(model));
  if (candidate.variant !== undefined && available.has(candidate.variant)) {
    return candidate.variant;
  }
  return pickModelVariant(model, fallbackOrder);
}

function firstResolvable(
  pool: Candidate[],
  candidates: readonly AutoRouteCandidate[],
  usage?: AutoProviderUsage,
): { chosen: Candidate; index: number } | undefined {
  for (let index = 0; index < candidates.length; index += 1) {
    const chosen = resolveCandidate(pool, candidates[index]!, usage);
    if (chosen) return { chosen, index };
  }
  return undefined;
}

type ResolvedCandidate = {
  chosen: Candidate;
  index: number;
  variant: AutoVariant | "";
  fellBack: boolean;
  usedPreset: boolean;
};

function buildDecision(
  pool: Candidate[],
  resolution: ResolvedCandidate,
  tier: AutoTier,
  mode: AutoOptimizeMode,
  hasImages: boolean,
  usage: AutoProviderUsage | undefined,
  candidates: readonly AutoRouteCandidate[],
  fromConfig: boolean,
  fallbackOrder: readonly IntelligenceVariant[],
): AutoDecision {
  const { chosen, index, variant } = resolution;
  let reason: string;
  if (fromConfig && index >= 0) {
    reason = `${TIER_LABEL[tier]}のため候補${index + 1}（${chosen.modelID}${variant ? ` / ${variant}` : ""}）を採用しました`;
    if (index > 0) reason += `（候補1〜${index}は利用不可）`;
  } else {
    reason = `${TIER_LABEL[tier]}のため${autoOptimizeModeLabel(mode)}で選択しました`;
  }
  if (hasImages) reason += "（画像対応モデルに限定）";
  if (!fromConfig && resolution.fellBack) {
    reason += "（該当コスト帯に候補がなく別コスト帯へフォールバック）";
  }

  const decision: AutoDecision = {
    providerID: chosen.providerID,
    modelID: chosen.modelID,
    ...(chosen.accountId ? { accountId: chosen.accountId } : {}),
    variant,
    tier,
    mode,
    reason,
  };
  if (fromConfig && index >= 0) decision.candidateIndex = index;
  if (resolution.usedPreset) decision.usedPreset = true;

  const escalationCandidates =
    fromConfig && index >= 0 ? candidates.slice(index + 1) : [];
  let escalation: Candidate | undefined;
  let escalationVariant: AutoVariant | "" = "";
  if (escalationCandidates.length > 0) {
    const next = firstResolvable(pool, escalationCandidates, usage);
    if (next) {
      escalation = next.chosen;
      const candidate = escalationCandidates[next.index];
      escalationVariant = candidate
        ? resolveCandidateVariant(escalation.model, candidate, fallbackOrder)
        : "";
    }
  }
  if (!escalation) {
    const alternateProviders = pool.filter(
      (item) => item.providerID !== chosen.providerID,
    );
    escalation = pickBest(
      alternateProviders.length > 0 ? alternateProviders : pool,
      usage,
    );
    escalationVariant = escalation
      ? pickVariant(escalation, ESCALATION_VARIANT_ORDER)
      : "";
  }
  if (
    escalation &&
    (escalation.providerID !== chosen.providerID ||
      escalation.modelID !== chosen.modelID ||
      escalation.accountId !== chosen.accountId ||
      escalationVariant !== variant)
  ) {
    decision.escalation = {
      providerID: escalation.providerID,
      modelID: escalation.modelID,
      ...(escalation.accountId ? { accountId: escalation.accountId } : {}),
      variant: escalationVariant,
    };
  }
  return decision;
}

export function chooseAutoModel(input: {
  models?: readonly ModelOption[];
  providers?: readonly AutoCandidateProvider[];
  connected?: readonly string[];
  disabled?: Record<string, true>;
  tier: AutoTier;
  hasImages: boolean;
  mode?: AutoOptimizeMode;
  usage?: AutoProviderUsage;
  config?: AutoRouteConfig;
  overrides?: RouteOverrides;
}): AutoDecision | null {
  const mode = input.mode ?? DEFAULT_AUTO_OPTIMIZE_MODE;
  const pool = candidatesFromInput({
    models: input.models,
    providers: input.providers,
    connected: input.connected,
    disabled: input.disabled ?? {},
    hasImages: input.hasImages,
  });
  if (pool.length === 0) return null;

  const config = input.config ?? EMPTY_AUTO_ROUTE_CONFIG;
  const legacyOverride = input.overrides?.[input.tier];
  const configured = config.modes[mode]?.[input.tier];
  const usableConfigured =
    configured && (configured.candidates.length > 0 || configured.variantFallbackOrder)
      ? configured
      : undefined;
  const preset = presetTierRoute(mode, input.tier);
  const configuredCandidates =
    usableConfigured !== undefined && usableConfigured.candidates.length > 0;
  const effective = usableConfigured ??
    (legacyOverride ? legacyRouteToTierRoute(legacyOverride) : preset);
  const candidates = effective.candidates.length > 0
    ? effective.candidates
    : preset.candidates;
  const fallbackOrder = effective.variantFallbackOrder ?? preset.variantFallbackOrder ?? [];
  const first = firstResolvable(pool, candidates, input.usage);

  if (first) {
    const candidate = candidates[first.index]!;
    return buildDecision(
      pool,
      {
        chosen: first.chosen,
        index: first.index,
        variant: resolveCandidateVariant(first.chosen.model, candidate, fallbackOrder),
        fellBack: !configuredCandidates && first.index > 0,
        usedPreset: false,
      },
      input.tier,
      mode,
      input.hasImages,
      input.usage,
      candidates,
      configuredCandidates,
      fallbackOrder,
    );
  }

  const fallback = effective.fallback ?? "preset";
  if (fallback === "error") return null;
  if (fallback === "preset") {
    const presetFirst = firstResolvable(pool, preset.candidates, input.usage);
    if (presetFirst) {
      const presetCandidate = preset.candidates[presetFirst.index]!;
      return buildDecision(
        pool,
        {
          chosen: presetFirst.chosen,
          index: presetFirst.index,
          variant: resolveCandidateVariant(
            presetFirst.chosen.model,
            presetCandidate,
            fallbackOrder,
          ),
          fellBack: true,
          usedPreset: true,
        },
        input.tier,
        mode,
        input.hasImages,
        input.usage,
        preset.candidates,
        false,
        fallbackOrder,
      );
    }
  }
  const strongest = pickBest(pool, input.usage);
  if (!strongest) return null;
  return buildDecision(
    pool,
    {
      chosen: strongest,
      index: -1,
      variant: pickVariant(strongest, fallbackOrder),
      fellBack: false,
      usedPreset: fallback === "preset",
    },
    input.tier,
    mode,
    input.hasImages,
    input.usage,
    preset.candidates,
    false,
    fallbackOrder,
  );
}

/** Convert an Auto variant to Pi's thinking-level field. */
export function autoVariantToThinkingLevel(
  variant: AutoVariant | "",
): ThinkingLevel | undefined {
  if (variant === "none" || variant === "thinking" || variant === "") return undefined;
  if (variant === "off") return "off";
  return ["minimal", "low", "medium", "high", "xhigh", "max"].includes(variant)
    ? variant
    : undefined;
}

export function autoModelValue(decision: {
  providerID: string;
  modelID: string;
  accountId?: string;
}): string {
  return `${decision.accountId ? `${decision.accountId}::` : ""}${decision.providerID}::${decision.modelID}`;
}

export function formatAutoDecisionNotice(
  decision: AutoDecision,
  options?: { showModel?: boolean },
): string {
  const model = options?.showModel === false
    ? "モデルを自動選択"
    : `${decision.providerID}/${decision.modelID}${decision.variant && decision.variant !== "none" && decision.variant !== "off" ? ` · effort ${decision.variant}` : ""}`;
  const reason = options?.showModel === false
    ? decision.reason.replaceAll(decision.modelID, "選択モデル")
    : decision.reason;
  return `Auto: ${model} — ${reason}`;
}

export function isAutoVariant(value: unknown): value is AutoVariant | "" {
  return value === "" || value === "off" || value === "none" || isIntelligenceVariant(value);
}
