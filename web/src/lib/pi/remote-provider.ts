import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const REMOTE_PROVIDER_ID = "remote-vllm";
export const REMOTE_PROVIDER_BASE = "http://100.120.239.27:8000/v1";

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
    const contextWindow =
      typeof row.max_model_len === "number" && row.max_model_len > 0
        ? row.max_model_len
        : 32_768;
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
    const response = await fetch(`${REMOTE_PROVIDER_BASE}/models`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    return modelRows(await response.json());
  } catch {
    return [];
  }
}

export async function registerRemoteProvider(runtime: RuntimeLike): Promise<void> {
  if (runtime.getProvider(REMOTE_PROVIDER_ID)) return;
  runtime.registerProvider(REMOTE_PROVIDER_ID, {
    name: "Remote vLLM",
    baseUrl: REMOTE_PROVIDER_BASE,
    api: openAICompletionsApi(),
    apiKey: "local",
    models: await fetchModels(),
  });
}
