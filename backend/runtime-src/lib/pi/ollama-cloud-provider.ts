import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  DEFAULT_OLLAMA_CLOUD_BASE,
  effectiveBaseUrl,
} from "@/lib/provider-endpoints";

export { DEFAULT_OLLAMA_CLOUD_BASE } from "@/lib/provider-endpoints";

export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud";
export const OLLAMA_API_KEY_ENV = "OLLAMA_API_KEY";

type RuntimeLike = {
  getProvider: (id: string) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerNativeProvider: (provider: any) => void;
  refresh: (options?: {
    providers?: readonly string[];
    force?: boolean;
    signal?: AbortSignal;
  }) => Promise<unknown>;
};

type OpenAiCompatModel = Model<"openai-completions">;

export function displayNameFromOllamaId(id: string): string {
  return id.trim() || id;
}

export function inferOllamaCapabilities(id: string): {
  reasoning: boolean;
  input: ("text" | "image")[];
} {
  const lower = id.toLowerCase();
  // ponytail: 既知のビジョン系ファミリー名の照合のみ。/api/tags の capabilities 等の
  // 正式ソースを使う場合は parseOllamaCloudModelsPayload ごと拡張する
  const vision =
    lower.includes("vl") ||
    lower.includes("vision") ||
    lower.includes("llava") ||
    lower.includes("minicpm") ||
    lower.includes("gemma3") ||
    lower.includes("gemma4") ||
    lower.includes("llama4") ||
    /mistral-small[-:.]?[23]/.test(lower);
  const reasoning =
    lower.includes("gpt-oss") ||
    lower.includes("deepseek-r1") ||
    lower.includes("thinking") ||
    /qwen3(\.|$|:)/.test(lower) ||
    lower.includes("kimi");
  return {
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
  };
}

export function toOllamaCloudModel(id: string, baseUrl = DEFAULT_OLLAMA_CLOUD_BASE): OpenAiCompatModel {
  const caps = inferOllamaCapabilities(id);
  return {
    id,
    name: displayNameFromOllamaId(id),
    api: "openai-completions",
    provider: OLLAMA_CLOUD_PROVIDER_ID,
    baseUrl,
    reasoning: caps.reasoning,
    input: caps.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_768,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
    },
  };
}

/** Parse `/v1/models` JSON into model ids (exported for tests). */
export function parseOllamaCloudModelsPayload(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return ids;
}

export async function fetchOllamaCloudModelIds(
  apiKey: string,
  options?: { baseUrl?: string; signal?: AbortSignal },
): Promise<string[]> {
  const base = (options?.baseUrl ?? DEFAULT_OLLAMA_CLOUD_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: options?.signal ?? AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Ollama Cloud のモデル一覧取得に失敗しました (${res.status})`);
  }
  return parseOllamaCloudModelsPayload(await res.json());
}

function envApiKey(): string | undefined {
  const key = process.env[OLLAMA_API_KEY_ENV]?.trim();
  return key || undefined;
}

function createOllamaCloudProvider() {
  // 設定（provider-endpoints.json）の上書きを優先。未保存は既定値。
  const baseUrl = effectiveBaseUrl(OLLAMA_CLOUD_PROVIDER_ID);
  return createProvider({
    id: OLLAMA_CLOUD_PROVIDER_ID,
    name: "Ollama Cloud",
    baseUrl,
    auth: {
      apiKey: {
        name: "Ollama Cloud API key",
        async login(interaction) {
          interaction.notify({
            type: "info",
            message: "ollama.com の API キーを入力してください",
            links: [{ url: "https://ollama.com/settings/keys", label: "API keys" }],
          });
          const key = (
            await interaction.prompt({
              type: "secret",
              message: "Ollama Cloud API key",
              placeholder: "…",
            })
          ).trim();
          if (!key) throw new Error("API キーが必要です");
          await fetchOllamaCloudModelIds(key, { baseUrl, signal: interaction.signal });
          return { type: "api_key", key };
        },
        async check({ credential, ctx }) {
          if (credential?.key?.trim()) {
            return { type: "api_key", source: "stored API key" };
          }
          const fromEnv = (await ctx.env(OLLAMA_API_KEY_ENV))?.trim();
          if (fromEnv) return { type: "api_key", source: OLLAMA_API_KEY_ENV };
          return undefined;
        },
        async resolve({ credential, ctx }) {
          const fromCred = credential?.key?.trim();
          const fromEnv = (await ctx.env(OLLAMA_API_KEY_ENV))?.trim() || envApiKey();
          const key = fromCred || fromEnv;
          if (!key) return undefined;
          return {
            auth: { apiKey: key, baseUrl },
            source: fromCred ? "stored API key" : OLLAMA_API_KEY_ENV,
          };
        },
      },
    },
    models: [],
    api: openAICompletionsApi(),
    async fetchModels(context) {
      if (!context.allowNetwork || context.signal.aborted) return [];
      const key =
        (context.credential?.type === "api_key" ? context.credential.key?.trim() : undefined) ||
        envApiKey();
      if (!key) return [];
      const ids = await fetchOllamaCloudModelIds(key, { baseUrl, signal: context.signal });
      return ids.map((id) => toOllamaCloudModel(id, baseUrl));
    },
  });
}

/** Register Ollama Cloud (https://ollama.com/v1) with API-key login + live catalog. */
export async function registerOllamaCloudProvider(runtime: RuntimeLike): Promise<void> {
  if (runtime.getProvider(OLLAMA_CLOUD_PROVIDER_ID)) return;
  try {
    runtime.registerNativeProvider(createOllamaCloudProvider());
  } catch (error) {
    console.warn(
      "[LeafCodePi] ollama-cloud provider registration failed:",
      error instanceof Error ? error.message : error,
    );
    return;
  }
  await syncOllamaCloudProvider(runtime);
}

/** Refresh the live /v1/models catalog when credentials are available. */
export async function syncOllamaCloudProvider(runtime: RuntimeLike): Promise<void> {
  if (!runtime.getProvider(OLLAMA_CLOUD_PROVIDER_ID)) return;
  try {
    await runtime.refresh({
      providers: [OLLAMA_CLOUD_PROVIDER_ID],
      force: true,
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    /* offline / unauthenticated — leave empty catalog */
  }
}
