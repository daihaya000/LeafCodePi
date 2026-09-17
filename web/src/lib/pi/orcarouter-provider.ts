import type { UsageScope } from "@/lib/codexbar/types";

export const ORCAROUTER_PROVIDER_ID = "orcarouter";
export const ORCAROUTER_API_KEY_ENV = "ORCAROUTER_API_KEY";
export const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;

type RawModel = {
  id?: unknown;
  name?: unknown;
  supported_endpoint_types?: unknown;
  context_length?: unknown;
  max_completion_tokens?: unknown;
  top_provider?: unknown;
  architecture?: unknown;
  pricing?: unknown;
};

type ModelRow = {
  id: string;
  name: string;
  api: "openai-completions";
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
    supportsUsageInStreaming: boolean;
    maxTokensField: "max_completion_tokens";
    requiresToolResultName: boolean;
    requiresAssistantAfterToolResult: boolean;
    requiresThinkingAsText: boolean;
    requiresReasoningContentOnAssistantMessages: boolean;
    thinkingFormat: "openai";
    supportsStrictMode: boolean;
    supportsStore: boolean;
  };
};

type StoredModelRow = ModelRow & { provider: typeof ORCAROUTER_PROVIDER_ID };

type RefreshModelsContext = {
  allowNetwork: boolean;
  signal: AbortSignal;
  credential?: { type?: string; key?: string };
  stored?: { models?: readonly unknown[] };
  publish?: (publication: {
    persist?: { models: readonly StoredModelRow[] };
  }) => Promise<boolean>;
};

type RuntimeLike = {
  getProvider: (id: string) => unknown;
  registerProvider: (id: string, config: Record<string, unknown>) => void;
  refresh: (options?: {
    providers?: readonly string[];
    force?: boolean;
    signal?: AbortSignal;
  }) => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown, fallback: number): number {
  const number =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = positiveNumber(value, fallback);
  return number >= 1 ? Math.floor(number) : fallback;
}

function modelObject(value: unknown): RawModel | null {
  return isRecord(value) ? (value as RawModel) : null;
}

function supportsOpenAiChat(model: RawModel): boolean {
  const endpoints = model.supported_endpoint_types;
  return Array.isArray(endpoints) && endpoints.includes("openai");
}

function inputModalities(model: RawModel): ("text" | "image")[] {
  const architecture = isRecord(model.architecture) ? model.architecture : null;
  const modalities = architecture?.input_modalities;
  return [
    "text",
    ...(Array.isArray(modalities) && modalities.includes("image")
      ? (["image"] as const)
      : []),
  ];
}

/** OrcaRouter does not expose a normalized reasoning capability flag. */
export function isOrcaRouterReasoningModel(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    /\bo[1-9](?:$|[-_.:])/i.test(lower) ||
    lower.includes("gpt-5") ||
    lower.includes("gpt-6") ||
    lower.includes("gpt-oss") ||
    lower.includes("claude") ||
    lower.includes("gemini-2.5") ||
    lower.includes("gemini-3") ||
    lower.includes("grok-3") ||
    lower.includes("grok-4") ||
    lower.includes("deepseek-r") ||
    lower.includes("deepseek-v3") ||
    lower.includes("qwq") ||
    lower.includes("thinking") ||
    lower.includes("reasoner") ||
    lower.includes("minimax") ||
    lower.includes("glm-4.5") ||
    lower.includes("glm-4.6") ||
    lower.includes("kimi") ||
    lower.includes("fusion")
  );
}

function priceValue(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function pricePerToken(
  pricing: Record<string, unknown> | null,
  perTokenKey: string,
  perMillionKey: string,
): number {
  if (!pricing) return 0;
  const perToken = priceValue(pricing[perTokenKey]);
  if (perToken !== null) return perToken;
  const perMillion = priceValue(pricing[perMillionKey]);
  return perMillion === null ? 0 : perMillion / 1_000_000;
}

function modelCost(model: RawModel): ModelRow["cost"] {
  const pricing = isRecord(model.pricing) ? model.pricing : null;
  return {
    input: pricePerToken(pricing, "prompt", "prompt_per_million"),
    output: pricePerToken(pricing, "completion", "completion_per_million"),
    cacheRead: 0,
    cacheWrite: 0,
  };
}

const DEFAULT_THINKING_LEVEL_MAP = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};
const GPT_OSS_THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
};
const OPENAI_REASONING_THINKING_LEVEL_MAP = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

function thinkingLevelMap(
  id: string,
  reasoning: boolean,
): Record<string, string | null> | undefined {
  if (!reasoning) return undefined;
  const lower = id.toLowerCase();
  if (lower.includes("gpt-oss")) return GPT_OSS_THINKING_LEVEL_MAP;
  const openAiReasoning =
    lower.includes("gpt-5") ||
    lower.includes("gpt-6") ||
    /\bo[1-9](?:$|[-_.:])/i.test(lower);
  if (openAiReasoning) return OPENAI_REASONING_THINKING_LEVEL_MAP;
  return DEFAULT_THINKING_LEVEL_MAP;
}

function modelRow(model: RawModel, baseUrl: string): ModelRow | null {
  if (typeof model.id !== "string" || !model.id.trim()) return null;
  if (!supportsOpenAiChat(model)) return null;

  const id = model.id.trim();
  const topProvider = isRecord(model.top_provider) ? model.top_provider : null;
  const contextWindow = positiveInteger(
    model.context_length,
    positiveInteger(topProvider?.context_length, DEFAULT_CONTEXT_WINDOW),
  );
  const maxTokens = Math.min(
    contextWindow,
    positiveInteger(
      model.max_completion_tokens,
      positiveInteger(topProvider?.max_completion_tokens, DEFAULT_MAX_TOKENS),
    ),
  );
  const reasoning = isOrcaRouterReasoningModel(id);

  return {
    id,
    name:
      typeof model.name === "string" && model.name.trim()
        ? model.name.trim()
        : id,
    api: "openai-completions",
    baseUrl,
    reasoning,
    thinkingLevelMap: thinkingLevelMap(id, reasoning),
    input: inputModalities(model),
    cost: modelCost(model),
    contextWindow,
    maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
      supportsUsageInStreaming: true,
      maxTokensField: "max_completion_tokens",
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: false,
      thinkingFormat: "openai",
      supportsStrictMode: false,
      supportsStore: false,
    },
  };
}

/** Convert GET /v1/models into Pi's OpenAI-compatible model definitions. */
export function parseOrcaRouterModelRows(
  body: unknown,
  baseUrl = ORCAROUTER_BASE_URL,
): ModelRow[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  const seen = new Set<string>();
  const rows: ModelRow[] = [];
  for (const value of body.data) {
    const row = modelRow(modelObject(value) ?? {}, baseUrl);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

export async function fetchOrcaRouterModelRows(
  apiKey: string,
  options?: { baseUrl?: string; signal?: AbortSignal },
): Promise<ModelRow[]> {
  const baseUrl = (options?.baseUrl ?? ORCAROUTER_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: options?.signal ?? AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (!response.ok) {
    const snippet = body.length > 200 ? body.slice(0, 200) : body;
    throw new Error(
      `OrcaRouter のモデル一覧取得に失敗しました (${response.status}): ${snippet}`,
    );
  }
  let models: ModelRow[];
  try {
    models = parseOrcaRouterModelRows(body ? JSON.parse(body) : null, baseUrl);
  } catch (error) {
    throw new Error("OrcaRouter のモデル一覧を解析できませんでした", {
      cause: error,
    });
  }
  if (models.length === 0) {
    throw new Error("OrcaRouter の利用可能なモデルがありません。");
  }
  return models;
}

function ambientApiKey(scope?: UsageScope): string | undefined {
  if (scope?.kind === "account") return undefined;
  const key = process.env[ORCAROUTER_API_KEY_ENV]?.trim();
  return key || undefined;
}

/** Register OrcaRouter with API-key auth and a live /v1/models catalog. */
export async function registerOrcaRouterProvider(
  runtime: RuntimeLike,
  scope?: UsageScope,
): Promise<void> {
  if (runtime.getProvider(ORCAROUTER_PROVIDER_ID)) return;

  runtime.registerProvider(ORCAROUTER_PROVIDER_ID, {
    name: "OrcaRouter",
    baseUrl: ORCAROUTER_BASE_URL,
    api: "openai-completions",
    // Account runtimes keep the auth method but must not resolve the shared env key.
    apiKey:
      scope?.kind === "account"
        ? "$LEAFCODEPI_ORCAROUTER_ACCOUNT_API_KEY"
        : `$${ORCAROUTER_API_KEY_ENV}`,
    models: [],
    refreshModels: async (context: RefreshModelsContext) => {
      if (!context.allowNetwork || context.signal.aborted) {
        return (context.stored?.models ?? []).filter(
          (model): model is StoredModelRow =>
            isRecord(model) && model.provider === ORCAROUTER_PROVIDER_ID,
        );
      }
      const storedKey =
        context.credential?.type === "api_key"
          ? context.credential.key?.trim()
          : undefined;
      const apiKey = storedKey || ambientApiKey(scope);
      if (!apiKey) return [];
      const models = await fetchOrcaRouterModelRows(apiKey, {
        signal: context.signal,
      });
      await context.publish?.({
        persist: {
          models: models.map((model) => ({
            ...model,
            provider: ORCAROUTER_PROVIDER_ID,
          })),
        },
      });
      return models;
    },
  });

  await syncOrcaRouterProvider(runtime);
}

/** Refresh OrcaRouter's model catalog without failing runtime startup. */
export async function syncOrcaRouterProvider(
  runtime: RuntimeLike,
): Promise<void> {
  if (!runtime.getProvider(ORCAROUTER_PROVIDER_ID)) return;
  try {
    await runtime.refresh({
      providers: [ORCAROUTER_PROVIDER_ID],
      force: true,
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    /* Offline or unauthenticated: keep the last cached catalog. */
  }
}
