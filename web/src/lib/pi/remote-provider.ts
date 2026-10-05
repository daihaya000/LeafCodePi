import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  effectiveBaseUrl,
  REMOTE_PROVIDER_BASE,
} from "@/lib/provider-endpoints";
import { readPiApiKey } from "@/lib/codexbar/pi-auth";
import { hasSystemOneEndpoint, isJevModel } from "@/lib/jev-model-catalog";

export { REMOTE_PROVIDER_BASE } from "@/lib/provider-endpoints";

export const REMOTE_PROVIDER_ID = "leafcodecloud";
export const REMOTE_PROVIDER_API_KEY_ENV = "LEAFCODECLOUD_API_KEY";
const REMOTE_CONTEXT_WINDOW = 131_072;
const REMOTE_JEV_MODEL_ID = "jev-latest";

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

type ClassifierRow = {
  id: string;
  name: string;
  type: "classifier";
  api: "typesafe-system-one";
  provider: string;
  baseUrl: string;
  input: ("text" | "image")[];
  cost: ModelRow["cost"];
  contextWindow: number;
};
type RemoteCatalog = { models: ModelRow[]; classifiers: ClassifierRow[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validModelId(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
}

function decisionRow(row: Record<string, unknown>): boolean {
  return row.type === "classifier" || row.type === "jev" || isJevModel(row)
    || (typeof row.id === "string" && /^(?:LeafJev(?:Sub)?|jev-latest)$/.test(row.id));
}

function classifierRow(id: string, name: string, baseUrl: string): ClassifierRow {
  return {
    id, name, type: "classifier", api: "typesafe-system-one", provider: REMOTE_PROVIDER_ID,
    baseUrl, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: REMOTE_CONTEXT_WINDOW,
  };
}

/** Explicit System One rows only; never adopt catalog-provided credential destinations. */
export function classifierRows(body: unknown, baseUrl = REMOTE_PROVIDER_BASE): ClassifierRow[] {
  if (!isRecord(body)) return [];
  const rows = Array.isArray(body.classifiers) ? body.classifiers : Array.isArray(body.data) ? body.data : [];
  const found = new Map<string, ClassifierRow>();
  for (const row of rows) {
    if (!isRecord(row) || !validModelId(row.id) || !hasSystemOneEndpoint(row)) continue;
    if (row.type !== undefined && !["classifier", "jev", "chat", "model"].includes(String(row.type))) continue;
    // Keep the existing GPU1 setting usable without rewriting user selections.
    const mainAlias = row.gpu === 1 && Array.isArray(row.aliases) && row.aliases.includes(REMOTE_JEV_MODEL_ID);
    const id = mainAlias || row.id === "LeafJev" ? REMOTE_JEV_MODEL_ID : row.id;
    const name = typeof row.name === "string" && row.name.trim() ? row.name.slice(0, 256) : row.id;
    found.set(id, classifierRow(id, name, baseUrl));
  }
  return [...found.values()];
}

export function modelRows(
  body: unknown,
  baseUrl = REMOTE_PROVIDER_BASE,
): ModelRow[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  return body.data.flatMap((row) => {
    if (!isRecord(row) || !validModelId(row.id) || decisionRow(row)) return [];
    if (row.type !== undefined && row.type !== "chat" && row.type !== "model") return [];
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

async function fetchModels(baseUrl: string): Promise<RemoteCatalog> {
  const legacy = { models: [], classifiers: [classifierRow(REMOTE_JEV_MODEL_ID, "LeafJev", baseUrl)] };
  try {
    const apiKey = remoteProviderApiKey();
    if (!apiKey) return legacy;
    const response = await fetch(`${baseUrl}/models`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return legacy;
    const body: unknown = await response.json();
    const classifiers = classifierRows(body, baseUrl);
    // An explicit empty catalog means no classifiers, not a phantom legacy model.
    const explicit = isRecord(body) && Array.isArray(body.classifiers);
    return { models: modelRows(body, baseUrl), classifiers: explicit || classifiers.length ? classifiers : legacy.classifiers };
  } catch {
    return legacy;
  }
}

function providerConfig(
  catalog: RemoteCatalog,
  baseUrl: string,
): Record<string, unknown> {
  return {
    name: "LeafCodeCloud",
    baseUrl,
    api: openAICompletionsApi(),
    apiKey: remoteProviderApiKey() ?? "",
    models: [...catalog.models, ...catalog.classifiers],
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
