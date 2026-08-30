import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const REMOTE_PROVIDER_ID = "leafcodecloud";
export const REMOTE_PROVIDER_BASE = "https://z390-s01.tail3dc57b.ts.net/v1";
export const REMOTE_PROVIDER_API_KEY_ENV = "LEAFCODECLOUD_API_KEY";
const REMOTE_CONTEXT_WINDOW = 131_072;

type RuntimeLike = {
  getProvider: (id: string) => unknown;
  registerProvider: (id: string, config: Record<string, unknown>) => void;
};

type ModelRow = {
  id: string;
  name: string;
  api: "openai-completions";
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ["text"];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
    supportsStore: boolean;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function modelRows(body: unknown): ModelRow[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  return body.data.flatMap((row) => {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim()) return [];
    const contextWindow = REMOTE_CONTEXT_WINDOW;
    const reasoning = /qwen3|deepseek-r1|thinking/i.test(row.id);
    return [{
      id: row.id,
      name: row.id,
      api: "openai-completions",
      provider: REMOTE_PROVIDER_ID,
      baseUrl: REMOTE_PROVIDER_BASE,
      reasoning,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: Math.min(contextWindow, 32_768),
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStore: false,
      },
    }];
  });
}

async function fetchModels(): Promise<ModelRow[]> {
  try {
    const apiKey = process.env[REMOTE_PROVIDER_API_KEY_ENV]?.trim();
    if (!apiKey) return [];
    const response = await fetch(`${REMOTE_PROVIDER_BASE}/models`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    return modelRows(await response.json());
  } catch {
    return [];
  }
}

function providerConfig(models: ModelRow[]): Record<string, unknown> {
  return {
    name: "LeafCodeCloud",
    baseUrl: REMOTE_PROVIDER_BASE,
    api: openAICompletionsApi(),
    apiKey: process.env[REMOTE_PROVIDER_API_KEY_ENV]?.trim() ?? "",
    models,
  };
}

/** Re-fetch `/v1/models` and replace the registered provider catalog. */
export async function syncRemoteProvider(runtime: RuntimeLike): Promise<void> {
  runtime.registerProvider(REMOTE_PROVIDER_ID, providerConfig(await fetchModels()));
}

export async function registerRemoteProvider(runtime: RuntimeLike): Promise<void> {
  if (runtime.getProvider(REMOTE_PROVIDER_ID)) return;
  await syncRemoteProvider(runtime);
}
