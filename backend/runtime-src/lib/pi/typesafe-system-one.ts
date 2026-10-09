import { recordTypesafeUsage } from "@/lib/codexbar/providers/typesafe";
import { jevModelKey } from "@/lib/jev-model-catalog";
import { toDecisionsRequest, fromDecisionsResponse } from "./openai-decisions";
import { enabledJevModelKeys } from "@/lib/jev-model-settings";
import { accountProviderModelKey, readProviderModelState } from "@/lib/provider-model-state";
import { accountRoutingMode, readProviderRouting } from "@/lib/provider-routing";
import { recordJevLatency } from "./jev-latency";
import { readJevModelSettings, resolveJevModelConnection } from "./jev-model-config";

type TypeSafeQuestion = {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string | null> | readonly string[];
};

export type TypeSafeRequest = {
  state: string | object | readonly unknown[];
  questions: Record<string, TypeSafeQuestion>;
};

export type TypeSafeAnswer = {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  confidence?: number;
  score?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
};

/** Optional per-call restriction; never enables models or changes saved settings. */
export type JevModelSelector = {
  provider?: string;
  model?: string;
  accountId?: string;
};

function validateSelector(selector: JevModelSelector): void {
  for (const [key, value] of Object.entries(selector)) {
    if (value !== undefined && (typeof value !== "string" || !value || value.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(value))) {
      throw new Error(`Jev: ${key} must be a non-empty ID without whitespace (max 256 characters)`);
    }
  }
  if (selector.accountId !== undefined && selector.provider === undefined) {
    throw new Error("Jev: accountId requires provider");
  }
}

function matchesSelector(ref: { providerId: string; modelId: string; accountId?: string }, selector: JevModelSelector): boolean {
  return (selector.provider === undefined || ref.providerId === selector.provider) &&
    (selector.model === undefined || ref.modelId === selector.model) &&
    (selector.accountId === undefined || ref.accountId === selector.accountId);
}

export type TypeSafeResponse = {
  model: string;
  answers: Record<string, TypeSafeAnswer | undefined>;
  usage: { input_tokens: number; output_tokens: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inRange(value: unknown, max = 1): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}

/** Validate at the shared boundary: malformed judgments must also abort compaction. */
function validateResponse(result: unknown, request: TypeSafeRequest): asserts result is TypeSafeResponse {
  if (!isRecord(result) || typeof result.model !== "string" || !result.model || !isRecord(result.answers) || !isRecord(result.usage)) {
    throw new Error("Jev API returned an invalid response");
  }
  for (const key of ["input_tokens", "output_tokens"]) {
    const count = result.usage[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error("Jev API returned invalid usage");
  }
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = result.answers[id];
    if (!isRecord(answer) || answer.type !== question.type) throw new Error("Jev API returned a missing or mismatched answer");
    if (question.type === "noul") {
      if (!inRange(answer.noul)) throw new Error("Jev API returned an invalid noul");
    } else {
      if (!inRange(answer.confidence)) throw new Error("Jev API returned invalid confidence");
      if (question.type === "choice") {
        if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria ?? {}, answer.choice)) {
          throw new Error("Jev API returned an unknown choice");
        }
      } else if (!Array.isArray(question.criteria) || !inRange(answer.score, question.criteria.length - 1)) {
        throw new Error("Jev API returned an invalid score");
      }
    }
  }
}

/** Only explicitly enabled models receive state; catalog order controls fallback priority. */
export async function evaluateTypeSafe(
  request: TypeSafeRequest,
  options: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    selector?: JevModelSelector;
  } = {},
): Promise<TypeSafeResponse> {
  const selector = options.selector ?? {};
  validateSelector(selector);
  const explicitlySelected = Object.values(selector).some((value) => value !== undefined);
  const settings = readJevModelSettings();
  const registered = settings.enabledModels ?? (settings.provider === "registered" ? settings.registeredModel ? [settings.registeredModel] : [] : undefined);
  // A catalog read never rewrites saved selections or enables an unselected replacement.
  const models = registered ? await (await import("./harness")).listJevModels() : [];
  const detectedKeys = enabledJevModelKeys(settings, models.filter((model) => model.providerEnabled !== false));
  const selected = registered?.filter((ref) => detectedKeys.has(jevModelKey(ref)));
  const state = selected || explicitlySelected ? readProviderModelState() : null;
  const routing = selected ? readProviderRouting() : null;
  const integrated = new Set(selected?.filter((ref) => ref.accountId && routing && accountRoutingMode(ref.providerId, routing) === "integrated").map((ref) => ref.providerId));
  const integratedRank = new Map<string, number>();
  for (const ref of selected ?? []) {
    if (!ref.accountId || !integrated.has(ref.providerId)) continue;
    const rank = state?.providerOrder.indexOf(`${ref.accountId}::${ref.providerId}`) ?? -1;
    if (rank >= 0) integratedRank.set(ref.providerId, Math.min(integratedRank.get(ref.providerId) ?? rank, rank));
  }
  const providerRank = (ref: { providerId: string; accountId?: string }) => {
    const providerIndex = state?.providerOrder.indexOf(ref.providerId) ?? -1;
    if (integrated.has(ref.providerId)) return providerIndex >= 0 ? providerIndex : integratedRank.get(ref.providerId) ?? -1;
    const accountRank = ref.accountId ? state?.providerOrder.indexOf(`${ref.accountId}::${ref.providerId}`) ?? -1 : -1;
    return accountRank >= 0 ? accountRank : providerIndex;
  };
  const modelRank = (ref: { providerId: string; accountId?: string; modelId: string }) => {
    const ids = (ref.accountId && state?.modelOrder[`${ref.accountId}::${ref.providerId}`]) || state?.modelOrder[ref.providerId] || [];
    const index = ids.indexOf(ref.modelId);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  // Selections under a disabled provider stay saved but are paused until the provider is re-enabled.
  const paused = (ref: { providerId: string; accountId?: string }) => state?.disabled?.[accountProviderModelKey(ref.providerId, ref.accountId)] === true;
  const refs = selected?.filter((ref) => !paused(ref)).map((ref, index) => ({ ref, index })).sort((a, b) => {
    const aRank = providerRank(a.ref);
    const bRank = providerRank(b.ref);
    if (aRank !== bRank) return (aRank < 0 ? Number.MAX_SAFE_INTEGER : aRank) - (bRank < 0 ? Number.MAX_SAFE_INTEGER : bRank);
    if (a.ref.providerId !== b.ref.providerId || a.ref.accountId !== b.ref.accountId) return a.index - b.index;
    return modelRank(a.ref) - modelRank(b.ref) || a.index - b.index;
  });
  const candidates = refs
    ? refs.map(({ ref }) => ref).filter((ref) => matchesSelector(ref, selector))
    : !paused({ providerId: settings.provider }) && matchesSelector({
      providerId: settings.provider,
      modelId: settings.provider === "typesafe" ? settings.typesafeModel : settings.compatibleModel,
    }, selector) ? [undefined] : [];
  if (explicitlySelected && candidates.length === 0) {
    throw new Error("Jev: no enabled, available model matches provider/model/accountId; enable it in Jev model settings first");
  }
  for (const [index, ref] of candidates.entries()) {
    if (index > 0 && options.signal?.aborted) throw options.signal.reason ?? new Error("Jev判定が中断されました");
    try {
      const { baseUrl, model, api, apiKey: storedKey, headers } = await resolveJevModelConnection(ref
        ? { ...settings, provider: "registered", registeredModel: ref }
        : settings);
      const apiKey = ref ? storedKey : options.apiKey ?? storedKey;
      // 認証解決は含めず、HTTP往復と本文検証だけを計測する。
      const startedAt = performance.now();
      const decisions = api === "decisions";
      const body = decisions ? toDecisionsRequest(request, model) : { ...request, model };
      const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/${decisions ? "decisions" : "systemone"}`, {
        method: "POST",
        headers: {
          ...headers,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          "Content-Type": "application/json",
        },
        redirect: "error",
        body: JSON.stringify(body),
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(settings.timeoutMs)])
          : AbortSignal.timeout(settings.timeoutMs),
      });
      if (!response.ok) throw new Error(`Jev API error: ${response.status}`);
      const raw: unknown = await response.json();
      const result: unknown = decisions ? fromDecisionsResponse(raw, request) : raw;
      validateResponse(result, request);
      recordJevLatency(result.model, performance.now() - startedAt);
      if (ref?.providerId === "typesafe" || !ref && settings.provider === "typesafe") recordTypesafeUsage(result.usage);
      return result;
    } catch (error) {
      if (options.signal?.aborted || index === candidates.length - 1) throw error;
    }
  }
  throw new Error("有効なJevモデルがありません");
}
