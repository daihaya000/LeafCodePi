import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  effectiveBaseUrl,
  REMOTE_PROVIDER_BASE,
} from "@/lib/provider-endpoints";
import { readPiApiKey } from "@/lib/codexbar/pi-auth";

export { REMOTE_PROVIDER_BASE } from "@/lib/provider-endpoints";

export const REMOTE_PROVIDER_ID = "leafcodecloud";
export const REMOTE_PROVIDER_API_KEY_ENV = "LEAFCODECLOUD_API_KEY";
const REMOTE_CONTEXT_WINDOW = 131_072;

/** Resolve the LeafCodeCloud API key: `~/.pi/agent/auth.json` takes precedence over the env var. */
function remoteProviderApiKey(): string | undefined {
  return readPiApiKey(REMOTE_PROVIDER_ID) ?? process.env[REMOTE_PROVIDER_API_KEY_ENV]?.trim();
}

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
  input: ("text" | "image")[];
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

export function modelRows(
  body: unknown,
  baseUrl = REMOTE_PROVIDER_BASE,
): ModelRow[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  return body.data.flatMap((row) => {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim()) return [];
    const contextWindow = REMOTE_CONTEXT_WINDOW;
    const imageInput = row.supports_image_input === true;
    const reasoning = /qwen3|deepseek-r1|thinking|leafmodel/i.test(row.id);
    return [{
      id: row.id,
      name: row.id,
      api: "openai-completions",
      provider: REMOTE_PROVIDER_ID,
      baseUrl,
      reasoning,
      input: imageInput ? ["text", "image"] : ["text"],
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

async function fetchModels(baseUrl: string): Promise<ModelRow[]> {
  try {
    const apiKey = remoteProviderApiKey();
    if (!apiKey) return [];
    const response = await fetch(`${baseUrl}/models`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    return modelRows(await response.json(), baseUrl);
  } catch {
    return [];
  }
}

function providerConfig(
  models: ModelRow[],
  baseUrl: string,
): Record<string, unknown> {
  return {
    name: "LeafCodeCloud",
    baseUrl,
    api: openAICompletionsApi(),
    apiKey: remoteProviderApiKey() ?? "",
    models,
  };
}

/** Re-fetch `/v1/models` and replace the registered provider catalog. */
export async function syncRemoteProvider(runtime: RuntimeLike): Promise<void> {
  // 登録済み runtime は再起動まで現在の URL を維持する。
  const registered = runtime.getProvider(REMOTE_PROVIDER_ID);
  const baseUrl =
    isRecord(registered) && typeof registered.baseUrl === "string"
      ? registered.baseUrl
      : effectiveBaseUrl(REMOTE_PROVIDER_ID);
  runtime.registerProvider(
    REMOTE_PROVIDER_ID,
    providerConfig(await fetchModels(baseUrl), baseUrl),
  );
}

export async function registerRemoteProvider(runtime: RuntimeLike): Promise<void> {
  if (runtime.getProvider(REMOTE_PROVIDER_ID)) return;
  await syncRemoteProvider(runtime);
}
