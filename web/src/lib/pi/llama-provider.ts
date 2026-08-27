import { basename } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { readSettingValue } from "@/lib/host-control";
import {
  LLAMA_SERVER_SETTINGS_KEY,
  parseLlamaServerSettings,
  type LlamaServerSettings,
} from "@/lib/llama-server-settings";

export const LLAMA_SERVER_PROVIDER_ID = "llama-server";
export const DEFAULT_LLAMA_SERVER_BASE = "http://127.0.0.1:8081";

/** Graded efforts accepted by Qwen3 GGUF chat templates on llama-server. */
export const LLAMA_QWEN_GRADED_EFFORTS = ["low", "medium", "xhigh"] as const;
export type LlamaQwenGradedEffort = (typeof LLAMA_QWEN_GRADED_EFFORTS)[number];

/**
 * Pi thinking levels → llama-server values for Qwen3-class GGUFs.
 * `off` maps to top-level `reasoning_effort: "none"` (not chat_template_kwargs).
 */
export const LLAMA_QWEN_THINKING_LEVEL_MAP = {
  off: "none",
  minimal: null,
  high: null,
  max: null,
  xhigh: "xhigh",
} as const;

/**
 * Ornith-1.5 GGUFs expose a boolean `enable_thinking` chat-template kwarg only.
 * `off` ("デフォルト") keeps the template default (thinking on); the one extra
 * level (`minimal`, labeled 最小) turns thinking off.
 */
export const LLAMA_ORNITH_THINKING_LEVEL_MAP = {
  off: "none",
  minimal: "no_think",
  low: null,
  medium: null,
  high: null,
  max: null,
} as const;

type RuntimeLike = {
  registerProvider: (id: string, config: Record<string, unknown>) => void;
};

type OpenAiModelRow = {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelIdFromFile(modelFile: string): string {
  const base = basename(modelFile.replace(/\\/g, "/"));
  return base.toLowerCase().endsWith(".gguf") ? base.slice(0, -5) : base;
}

function displayName(id: string): string {
  const short = basename(id.replace(/\\/g, "/"));
  return short.toLowerCase().endsWith(".gguf") ? short.slice(0, -5) : short || id;
}

/**
 * Qwen3 GGUFs (e.g. Qwen3.8-27B-Uncensored-GGUF) expose graded reasoning_effort
 * via the chat template. Ornith-1.5 GGUFs use a `<think>` template too, but only
 * with an `enable_thinking` boolean. Older / non-Qwen GGUFs stay non-reasoning.
 */
export function isLlamaQwenReasoningModel(id: string): boolean {
  const lower = id.toLowerCase().replace(/\\/g, "/");
  const base = basename(lower).replace(/\.gguf$/i, "");
  return /qwen3/.test(base) || /qwen[_.-]?3/.test(base);
}

export function isLlamaOrnithModel(id: string): boolean {
  const base = basename(id.toLowerCase().replace(/\\/g, "/")).replace(/\.gguf$/i, "");
  return /ornith/.test(base);
}

export function isLlamaQwenGradedEffort(value: unknown): value is LlamaQwenGradedEffort {
  return (
    typeof value === "string" &&
    (LLAMA_QWEN_GRADED_EFFORTS as readonly string[]).includes(value)
  );
}

function applyNoThinkPrefix(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (!isRecord(message) || message.role !== "user") continue;
    if (typeof message.content === "string") {
      if (!message.content.startsWith("/no_think")) {
        next[index] = { ...message, content: `/no_think\n${message.content}` };
      }
      break;
    }
    if (Array.isArray(message.content)) {
      const parts = message.content.map((part) => {
        if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part;
        if (part.text.startsWith("/no_think")) return part;
        return { ...part, text: `/no_think\n${part.text}` };
      });
      next[index] = { ...message, content: parts };
      break;
    }
  }
  return next;
}

/**
 * llama-server + Qwen3 template quirk (same as LeafCode):
 * - graded efforts must live in `chat_template_kwargs.reasoning_effort`
 * - `none` must be top-level `reasoning_effort` (kwargs reject it with HTTP 500)
 * - `/no_think` helps Qwen3 actually skip reasoning when off
 *
 * Ornith-1.5 templates ignore `reasoning_effort`; they accept
 * `chat_template_kwargs.enable_thinking: false` instead (no `/no_think` prefix —
 * that would just pollute the prompt).
 */
export function rewriteLlamaServerEffortPayload(
  payload: unknown,
  model: { id?: string; reasoning?: boolean },
): unknown {
  if (!model.reasoning || !isRecord(payload)) return payload;
  const body: Record<string, unknown> = { ...payload };
  const effort =
    typeof body.reasoning_effort === "string"
      ? body.reasoning_effort
      : isRecord(body.chat_template_kwargs) &&
          typeof body.chat_template_kwargs.reasoning_effort === "string"
        ? body.chat_template_kwargs.reasoning_effort
        : undefined;

  if (isLlamaOrnithModel(String(body.model ?? model.id ?? ""))) {
    const prev = isRecord(body.chat_template_kwargs) ? body.chat_template_kwargs : {};
    if (effort === "no_think") {
      body.chat_template_kwargs = { ...prev, enable_thinking: false };
    } else {
      if (Object.keys(prev).length > 0) body.chat_template_kwargs = prev;
      else delete body.chat_template_kwargs;
    }
    delete body.reasoning_effort;
    return body;
  }

  if (isLlamaQwenGradedEffort(effort)) {
    const prev = isRecord(body.chat_template_kwargs) ? body.chat_template_kwargs : {};
    body.chat_template_kwargs = { ...prev, reasoning_effort: effort };
    delete body.reasoning_effort;
    return body;
  }

  if (isRecord(body.chat_template_kwargs)) {
    const rest = { ...body.chat_template_kwargs };
    delete rest.reasoning_effort;
    if (Object.keys(rest).length > 0) body.chat_template_kwargs = rest;
    else delete body.chat_template_kwargs;
  }
  body.reasoning_effort = "none";
  body.messages = applyNoThinkPrefix(body.messages);
  return body;
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
  return ids.map((id) => {
    const ornith = isLlamaOrnithModel(id);
    const reasoning = ornith || isLlamaQwenReasoningModel(id);
    return {
      id,
      name: displayName(id),
      reasoning,
      ...(reasoning
        ? {
            thinkingLevelMap:
              ornith ? { ...LLAMA_ORNITH_THINKING_LEVEL_MAP } : { ...LLAMA_QWEN_THINKING_LEVEL_MAP },
          }
        : {}),
      input: ["text"] as ("text" | "image")[],
      contextWindow,
      maxTokens: Math.min(contextWindow, 32_768),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: reasoning,
        supportsStore: false,
      },
    };
  });
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

function llamaStreamSimple(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const previous = options?.onPayload;
  return streamSimple(model, context, {
    ...options,
    onPayload: async (payload, current) => {
      let next: unknown = rewriteLlamaServerEffortPayload(payload, current);
      if (previous) {
        const replaced = await previous(next, current);
        if (replaced !== undefined) next = replaced;
      }
      return next;
    },
  });
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
    streamSimple: llamaStreamSimple,
    refreshModels: async () => {
      const latest = parseLlamaServerSettings(readSettingValue(LLAMA_SERVER_SETTINGS_KEY));
      return resolveModelRows(latest);
    },
  };
}

/** Re-read /v1/models and update the registered openai-compatible provider. */
export async function syncLlamaServerProvider(runtime: RuntimeLike): Promise<void> {
  const settings = parseLlamaServerSettings(readSettingValue(LLAMA_SERVER_SETTINGS_KEY));
  const models = await resolveModelRows(settings);
  runtime.registerProvider(LLAMA_SERVER_PROVIDER_ID, providerConfig(models));
}

/** Register the OpenAI-compatible `llama-server` provider. */
export async function registerLlamaProviders(runtime: RuntimeLike): Promise<void> {
  await syncLlamaServerProvider(runtime);
}
