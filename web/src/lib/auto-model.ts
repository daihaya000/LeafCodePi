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

export type AutoVariant = IntelligenceVariant | "off";

export type AutoDecision = {
  providerID: string;
  modelID: string;
  accountId?: string;
  variant: AutoVariant | "";
  tier: AutoTier;
  mode: AutoOptimizeMode;
  reason: string;
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
  Record<AutoTier, readonly AutoVariant[]>
> = {
  cost: {
    light: ["minimal", "none", "off", "low"],
    standard: ["low", "minimal", "none", "off", "medium"],
    heavy: ["medium", "high", "low", "minimal"],
  },
  balanced: {
    light: ["low", "minimal", "none", "off", "medium"],
    standard: ["medium", "low", "high", "minimal", "none", "off"],
    heavy: ["high", "medium", "max", "low", "minimal"],
  },
  intelligence: {
    light: ["medium", "low", "high", "minimal", "none", "off"],
    standard: ["high", "medium", "max", "low", "minimal"],
    heavy: ["max", "high", "medium", "low", "minimal"],
  },
};

const ESCALATION_VARIANT_ORDER: readonly AutoVariant[] = [
  "high",
  "max",
  "medium",
  "low",
  "minimal",
];

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
};

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

function pickBest(candidates: Candidate[]): Candidate | undefined {
  return candidates.reduce<Candidate | undefined>(
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

function chooseFromCostOrder(
  pool: Candidate[],
  order: ModelCostTier[] | null,
): { candidate: Candidate; fallback: boolean } | undefined {
  if (order === null) {
    const candidate = pickBest(pool);
    return candidate ? { candidate, fallback: false } : undefined;
  }
  for (const [index, cost] of order.entries()) {
    const candidate = pickBest(pool.filter((item) => item.cost === cost));
    if (candidate) return { candidate, fallback: index > 0 };
  }
  return undefined;
}

export function chooseAutoModel(input: {
  models?: readonly ModelOption[];
  providers?: readonly AutoCandidateProvider[];
  connected?: readonly string[];
  disabled?: Record<string, true>;
  tier: AutoTier;
  hasImages: boolean;
  mode?: AutoOptimizeMode;
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

  const selected = chooseFromCostOrder(pool, MODE_COST_ORDER[mode][input.tier]);
  if (!selected) return null;
  const variant = pickVariant(selected.candidate, MODE_VARIANT_ORDER[mode][input.tier]);
  const escalationCandidate = pickBest(pool);
  const escalationVariant = escalationCandidate
    ? pickVariant(escalationCandidate, ESCALATION_VARIANT_ORDER)
    : "";

  let reason =
    mode === "cost"
      ? `${TIER_LABEL[input.tier]}のため${input.tier === "light" ? "低コスト" : input.tier === "standard" ? "中コスト" : "高性能"}モデルを選択しました`
      : `${TIER_LABEL[input.tier]}のため${autoOptimizeModeLabel(mode)}で選択しました`;
  if (input.hasImages) reason += "（画像対応モデルに限定）";
  if (selected.fallback) reason += "（該当コスト帯に候補がなく上位帯へフォールバック）";

  const decision: AutoDecision = {
    providerID: selected.candidate.providerID,
    modelID: selected.candidate.modelID,
    ...(selected.candidate.accountId ? { accountId: selected.candidate.accountId } : {}),
    variant,
    tier: input.tier,
    mode,
    reason,
  };
  if (
    escalationCandidate &&
    (escalationCandidate.providerID !== selected.candidate.providerID ||
      escalationCandidate.modelID !== selected.candidate.modelID ||
      escalationCandidate.accountId !== selected.candidate.accountId ||
      escalationVariant !== variant)
  ) {
    decision.escalation = {
      providerID: escalationCandidate.providerID,
      modelID: escalationCandidate.modelID,
      ...(escalationCandidate.accountId
        ? { accountId: escalationCandidate.accountId }
        : {}),
      variant: escalationVariant,
    };
  }
  return decision;
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

export function formatAutoDecisionNotice(decision: AutoDecision): string {
  return `Auto: ${decision.providerID}/${decision.modelID}${decision.variant && decision.variant !== "none" && decision.variant !== "off" ? ` · effort ${decision.variant}` : ""} — ${decision.reason}`;
}

export function isAutoVariant(value: unknown): value is AutoVariant | "" {
  return value === "" || value === "off" || value === "none" || isIntelligenceVariant(value);
}
