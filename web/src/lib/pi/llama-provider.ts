import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readSettingValue } from "@/lib/host-control";
import {
  LLAMA_SERVER_SETTINGS_KEY,
  parseLlamaServerSettings,
  type LlamaServerSettings,
} from "@/lib/llama-server-settings";

export const LLAMA_SERVER_PROVIDER_ID = "llama-server";
export const DEFAULT_LLAMA_SERVER_BASE = "http://127.0.0.1:8081";

type RuntimeLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerNativeProvider: (provider: any) => void;
  registerProvider: (id: string, config: Record<string, unknown>) => void;
};

type OpenAiModelRow = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat: {
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
    supportsStore: boolean;
  };
};

function modelIdFromFile(modelFile: string): string {
  const base = basename(modelFile.replace(/\\/g, "/"));
  return base.toLowerCase().endsWith(".gguf") ? base.slice(0, -5) : base;
}

function displayName(id: string): string {
  const short = basename(id.replace(/\\/g, "/"));
  return short.toLowerCase().endsWith(".gguf") ? short.slice(0, -5) : short || id;
}

/**
 * Ask the running llama-server what model id(s) it accepts.
 * Prefers loaded router models; falls back to the full catalog.
 */
export async function fetchLlamaServerModelIds(
  baseUrl = DEFAULT_LLAMA_SERVER_BASE,
): Promise<string[]> {
  const root = baseUrl.replace(/\/$/, "").replace(/\/v1$/i, "");
  for (const path of ["/models", "/v1/models"]) {
    try {
      const res = await fetch(`${root}${path}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: unknown };
      if (!Array.isArray(body.data)) continue;
      const rows = body.data
        .map((row) => {
          if (!row || typeof row !== "object") return null;
          const id = (row as { id?: unknown }).id;
          if (typeof id !== "string" || !id.trim()) return null;
          const status =
            (row as { status?: { value?: unknown } }).status &&
            typeof (row as { status?: unknown }).status === "object"
              ? String((row as { status: { value?: unknown } }).status.value ?? "")
              : "";
          return { id: id.trim(), status };
        })
        .filter((row): row is { id: string; status: string } => Boolean(row));
      if (rows.length === 0) continue;
      const loaded = rows.filter((r) => r.status === "loaded").map((r) => r.id);
      if (loaded.length > 0) return loaded;
      // Unloaded-only catalog: still return ids so sync can run after ensure-loaded.
      return rows.map((r) => r.id);
    } catch {
      /* try next path / fall through */
    }
  }
  return [];
}

function buildModelRows(ids: string[], contextWindow: number): OpenAiModelRow[] {
  return ids.map((id) => ({
    id,
    name: `llama-server (${displayName(id)})`,
    reasoning: false,
    input: ["text"],
    contextWindow,
    maxTokens: Math.min(contextWindow, 32_768),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
    },
  }));
}

async function resolveModelRows(settings: LlamaServerSettings): Promise<OpenAiModelRow[]> {
  const contextWindow = settings.contextLength;
  const live = await fetchLlamaServerModelIds(DEFAULT_LLAMA_SERVER_BASE);
  if (live.length > 0) return buildModelRows(live, contextWindow);
  // Fallback guesses rarely match the server id (often a full path). Prefer empty
  // until /v1/models responds so the UI does not offer a 400-causing stub like "local".
  if (settings.modelFile.trim()) {
    return buildModelRows([modelIdFromFile(settings.modelFile)], contextWindow);
  }
  return [];
}

function providerConfig(models: OpenAiModelRow[]) {
  return {
    name: "llama-server",
    baseUrl: `${DEFAULT_LLAMA_SERVER_BASE}/v1`,
    api: "openai-completions" as const,
    apiKey: "local",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
    },
    models,
    refreshModels: async () => {
      const latest = parseLlamaServerSettings(readSettingValue(LLAMA_SERVER_SETTINGS_KEY));
      return resolveModelRows(latest);
    },
  };
}

async function loadCreateLlamaProvider(): Promise<(() => { provider: unknown }) | null> {
  try {
    const candidates = [
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "extensions", "llama", "provider.js"),
      join(process.cwd(), "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "extensions", "llama", "provider.js"),
    ];
    for (const file of candidates) {
      try {
        const mod = (await import(pathToFileURL(file).href)) as {
          createLlamaProvider?: () => { provider: unknown };
        };
        if (typeof mod.createLlamaProvider === "function") return mod.createLlamaProvider;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Re-read /v1/models and update the registered openai-compatible provider. */
export async function syncLlamaServerProvider(runtime: RuntimeLike): Promise<void> {
  const settings = parseLlamaServerSettings(readSettingValue(LLAMA_SERVER_SETTINGS_KEY));
  const models = await resolveModelRows(settings);
  runtime.registerProvider(LLAMA_SERVER_PROVIDER_ID, providerConfig(models));
}

/**
 * Register Pi's built-in llama.cpp (router) + OpenAI-compatible `llama-server`
 * whose model ids come from the live `/v1/models` catalog.
 */
export async function registerLlamaProviders(runtime: RuntimeLike): Promise<void> {
  if (!process.env.LLAMA_BASE_URL?.trim()) {
    process.env.LLAMA_BASE_URL = DEFAULT_LLAMA_SERVER_BASE;
  }

  const createLlama = await loadCreateLlamaProvider();
  if (createLlama) {
    try {
      runtime.registerNativeProvider(createLlama().provider);
    } catch {
      /* already registered or incompatible */
    }
  }

  await syncLlamaServerProvider(runtime);
}
