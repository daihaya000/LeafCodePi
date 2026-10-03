import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const EXPERIENTIALLABS_PROVIDER_ID = "experientiallabs";
export const EXPERIENTIALLABS_BASE_URL = "https://api.experientiallabs.ai/v1";
export const EXPERIENTIALLABS_API_KEY_ENV = "EXPLABS_API_KEY";

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

export function inferExperientialLabsCapabilities(id: string): {
  reasoning: boolean;
  input: ("text" | "image")[];
} {
  const lower = id.toLowerCase();
  const vision =
    lower.includes("vl") ||
    lower.includes("vision") ||
    lower.includes("llava") ||
    lower.includes("gemma3") ||
    lower.includes("gemma4") ||
    lower.includes("llama4");
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

export function toExperientialLabsModel(
  id: string,
  baseUrl = EXPERIENTIALLABS_BASE_URL,
): OpenAiCompatModel {
  const caps = inferExperientialLabsCapabilities(id);
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: EXPERIENTIALLABS_PROVIDER_ID,
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
export function parseExperientialLabsModelsPayload(body: unknown): string[] {
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

export async function fetchExperientialLabsModelIds(
  apiKey: string,
  options?: { baseUrl?: string; signal?: AbortSignal },
): Promise<string[]> {
  const base = (options?.baseUrl ?? EXPERIENTIALLABS_BASE_URL).replace(/\/$/, "");
  const res = await fetch(`${base}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: options?.signal ?? AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Experiential Labs のモデル一覧取得に失敗しました (${res.status})`);
  }
  return parseExperientialLabsModelsPayload(await res.json());
}

function envApiKey(): string | undefined {
  const key = process.env[EXPERIENTIALLABS_API_KEY_ENV]?.trim();
  return key || undefined;
}

function createExperientialLabsProvider() {
  const baseUrl = EXPERIENTIALLABS_BASE_URL;
  return createProvider({
    id: EXPERIENTIALLABS_PROVIDER_ID,
    name: "Experiential Labs",
    baseUrl,
    auth: {
      apiKey: {
        name: "Experiential Labs API key",
        async login(interaction) {
          interaction.notify({
            type: "info",
            message: "Experiential Labs の API キーを入力してください",
            links: [{ url: "https://platform.experientiallabs.ai/settings", label: "API keys" }],
          });
          const key = (
            await interaction.prompt({
              type: "secret",
              message: "Experiential Labs API key",
              placeholder: "xpl_…",
            })
          ).trim();
          if (!key) throw new Error("API キーが必要です");
          await fetchExperientialLabsModelIds(key, { baseUrl, signal: interaction.signal });
          return { type: "api_key", key };
        },
        async check({ credential, ctx }) {
          if (credential?.key?.trim()) {
            return { type: "api_key", source: "stored API key" };
          }
          const fromEnv = (await ctx.env(EXPERIENTIALLABS_API_KEY_ENV))?.trim();
          if (fromEnv) return { type: "api_key", source: EXPERIENTIALLABS_API_KEY_ENV };
          return undefined;
        },
        async resolve({ credential, ctx }) {
          const fromCred = credential?.key?.trim();
          const fromEnv = (await ctx.env(EXPERIENTIALLABS_API_KEY_ENV))?.trim() || envApiKey();
          const key = fromCred || fromEnv;
          if (!key) return undefined;
          return {
            auth: { apiKey: key, baseUrl },
            source: fromCred ? "stored API key" : EXPERIENTIALLABS_API_KEY_ENV,
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
      const ids = await fetchExperientialLabsModelIds(key, { baseUrl, signal: context.signal });
      return ids.map((id) => toExperientialLabsModel(id, baseUrl));
    },
  });
}

/** Register Experiential Labs (https://api.experientiallabs.ai/v1) with API-key login + live catalog. */
export async function registerExperientialLabsProvider(runtime: RuntimeLike): Promise<void> {
  if (runtime.getProvider(EXPERIENTIALLABS_PROVIDER_ID)) return;
  try {
    runtime.registerNativeProvider(createExperientialLabsProvider());
  } catch (error) {
    console.warn(
      "[LeafCodePi] experientiallabs provider registration failed:",
      error instanceof Error ? error.message : error,
    );
    return;
  }
  await syncExperientialLabsProvider(runtime);
}

/** Refresh the live /v1/models catalog when credentials are available. */
export async function syncExperientialLabsProvider(runtime: RuntimeLike): Promise<void> {
  if (!runtime.getProvider(EXPERIENTIALLABS_PROVIDER_ID)) return;
  try {
    await runtime.refresh({
      providers: [EXPERIENTIALLABS_PROVIDER_ID],
      force: true,
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    /* offline / unauthenticated — leave empty catalog */
  }
}
