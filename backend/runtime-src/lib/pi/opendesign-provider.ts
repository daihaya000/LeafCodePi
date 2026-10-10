import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { UsageScope } from "@/lib/codexbar/types";
import { DEFAULT_OPENDESIGN_BASE, effectiveBaseUrl } from "@/lib/provider-endpoints";

export const OPENDESIGN_PROVIDER_ID = "opendesign";
export const OPENDESIGN_API_KEY_ENV = "OPENDESIGN_API_KEY";

// OpenDesign Cloud's API-key console advertises this OpenAI-compatible endpoint.
export const OPENDESIGN_BASE_URL = DEFAULT_OPENDESIGN_BASE;

type OpenDesignModel = Model<"openai-completions">;
type RuntimeLike = {
  getProvider: (id: string) => unknown;
  registerNativeProvider: (provider: ReturnType<typeof createOpenDesignProvider>) => void;
  refresh: (options?: {
    providers?: readonly string[];
    force?: boolean;
    signal?: AbortSignal;
  }) => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}

/** Accept the standard OpenAI catalog; do not invent model IDs or token prices. */
export function parseOpenDesignModelRows(
  body: unknown,
  baseUrl = OPENDESIGN_BASE_URL,
): OpenDesignModel[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  const seen = new Set<string>();
  const models: OpenDesignModel[] = [];
  for (const row of body.data) {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim()) continue;
    const id = row.id.trim();
    if (seen.has(id)) continue;
    // Explicit non-chat entries must not appear in the agent's model selector.
    if (typeof row.type === "string" && row.type !== "chat") continue;
    if (Array.isArray(row.supported_endpoint_types) &&
        !row.supported_endpoint_types.includes("openai")) continue;
    if (/(?:embedding|rerank|whisper|tts|dall-e|image-generation)/i.test(id)) continue;
    seen.add(id);
    const contextWindow = positiveInteger(row.context_length, 128_000);
    const modalities = isRecord(row.architecture) ? row.architecture.input_modalities : row.input;
    models.push({
      id,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id,
      provider: OPENDESIGN_PROVIDER_ID,
      api: "openai-completions",
      baseUrl,
      reasoning: row.reasoning === true,
      input: Array.isArray(modalities) && modalities.includes("image") ? ["text", "image"] : ["text"],
      // The /models protocol does not guarantee pricing or capability metadata.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: Math.min(contextWindow, positiveInteger(row.max_completion_tokens, 8_192)),
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStore: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
    });
  }
  return models;
}

export async function fetchOpenDesignModelRows(
  apiKey: string,
  options?: { baseUrl?: string; signal?: AbortSignal },
): Promise<OpenDesignModel[]> {
  const baseUrl = (options?.baseUrl ?? OPENDESIGN_BASE_URL).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: options?.signal ?? AbortSignal.timeout(20_000),
  });
  // Never echo upstream error bodies: they may contain credentials/request data.
  if (!response.ok) throw new Error(`OpenDesign のモデル一覧取得に失敗しました (${response.status})`);
  let models: OpenDesignModel[];
  try {
    models = parseOpenDesignModelRows(await response.json(), baseUrl);
  } catch {
    throw new Error("OpenDesign のモデル一覧を解析できませんでした");
  }
  if (!models.length) throw new Error("OpenDesign の利用可能なモデルがありません");
  return models;
}

export function createOpenDesignProvider(scope?: UsageScope) {
  const baseUrl = effectiveBaseUrl(OPENDESIGN_PROVIDER_ID) || OPENDESIGN_BASE_URL;
  const accountScoped = scope?.kind === "account";
  const envApiKey = () => accountScoped ? undefined : process.env[OPENDESIGN_API_KEY_ENV]?.trim() || undefined;
  return createProvider({
    id: OPENDESIGN_PROVIDER_ID,
    name: "OpenDesign",
    baseUrl,
    api: openAICompletionsApi(),
    auth: {
      apiKey: {
        name: "OpenDesign API key",
        async login(interaction) {
          interaction.notify({
            type: "info",
            message: "OpenDesign Cloud の API キーを入力してください",
            links: [{ url: "https://open-design.ai/cloud/api-keys", label: "API keys" }],
          });
          const key = (await interaction.prompt({ type: "secret", message: "OpenDesign API key" })).trim();
          if (!key) throw new Error("API キーが必要です");
          await fetchOpenDesignModelRows(key, { baseUrl, signal: interaction.signal });
          return { type: "api_key", key };
        },
        async check({ credential, ctx }) {
          if (credential?.key?.trim()) return { type: "api_key", source: "stored API key" };
          if (!accountScoped && (await ctx.env(OPENDESIGN_API_KEY_ENV))?.trim()) {
            return { type: "api_key", source: OPENDESIGN_API_KEY_ENV };
          }
          return undefined;
        },
        async resolve({ credential, ctx }) {
          const storedKey = credential?.key?.trim();
          const key = storedKey || (!accountScoped && (await ctx.env(OPENDESIGN_API_KEY_ENV))?.trim()) || envApiKey();
          if (!key) return undefined;
          return { auth: { apiKey: key, baseUrl }, source: storedKey ? "stored API key" : OPENDESIGN_API_KEY_ENV };
        },
      },
    },
    models: [],
    async fetchModels(context) {
      if (!context.allowNetwork || context.signal.aborted) return [];
      const key = (context.credential?.type === "api_key" ? context.credential.key?.trim() : undefined) || envApiKey();
      if (!key) return [];
      return fetchOpenDesignModelRows(key, { baseUrl, signal: context.signal });
    },
  });
}

export async function registerOpenDesignProvider(runtime: RuntimeLike, scope?: UsageScope): Promise<void> {
  if (runtime.getProvider(OPENDESIGN_PROVIDER_ID)) return;
  runtime.registerNativeProvider(createOpenDesignProvider(scope));
  await syncOpenDesignProvider(runtime);
}

/** Offline/error refreshes retain the SDK's last successfully published catalog. */
export async function syncOpenDesignProvider(runtime: RuntimeLike): Promise<void> {
  if (!runtime.getProvider(OPENDESIGN_PROVIDER_ID)) return;
  try {
    await runtime.refresh({ providers: [OPENDESIGN_PROVIDER_ID], force: true, signal: AbortSignal.timeout(25_000) });
  } catch {
    /* Cached models remain available while the service is unreachable. */
  }
}
