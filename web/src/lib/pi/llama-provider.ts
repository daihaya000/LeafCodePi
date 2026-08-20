import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readSettingValue } from "@/lib/host-control";
import {
  LLAMA_SERVER_SETTINGS_KEY,
  parseLlamaServerSettings,
} from "@/lib/llama-server-settings";

const LLAMA_SERVER_PROVIDER_ID = "llama-server";
const DEFAULT_BASE = "http://127.0.0.1:8080";

type RuntimeLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerNativeProvider: (provider: any) => void;
  registerProvider: (id: string, config: Record<string, unknown>) => void;
};

function modelIdFromFile(modelFile: string): string {
  const base = basename(modelFile.replace(/\\/g, "/"));
  return base.toLowerCase().endsWith(".gguf") ? base.slice(0, -5) : base || "local";
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

/**
 * Register Pi's built-in llama.cpp (router) + a LeafCode-style single-model
 * openai-compatible `llama-server` provider from persisted settings.
 */
export async function registerLlamaProviders(runtime: RuntimeLike): Promise<void> {
  if (!process.env.LLAMA_BASE_URL?.trim()) {
    process.env.LLAMA_BASE_URL = DEFAULT_BASE;
  }

  const createLlama = await loadCreateLlamaProvider();
  if (createLlama) {
    try {
      runtime.registerNativeProvider(createLlama().provider);
    } catch {
      /* already registered or incompatible */
    }
  }

  const settings = parseLlamaServerSettings(readSettingValue(LLAMA_SERVER_SETTINGS_KEY));
  const modelId = settings.modelFile ? modelIdFromFile(settings.modelFile) : "local";
  const contextWindow = settings.contextLength;
  runtime.registerProvider(LLAMA_SERVER_PROVIDER_ID, {
    name: "llama-server",
    baseUrl: `${DEFAULT_BASE}/v1`,
    api: "openai-completions",
    apiKey: "local",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
    },
    models: [
      {
        id: modelId,
        name: settings.modelFile ? `llama-server (${modelId})` : "llama-server (local)",
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
      },
    ],
  });
}

export { LLAMA_SERVER_PROVIDER_ID };
