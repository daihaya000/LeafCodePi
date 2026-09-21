import { basename } from "node:path";
import { collapseSystemMessages, type Api, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { readSettingValue } from "@/lib/host-control";
import {
  LLAMA_SERVER_SETTINGS_KEY,
  llamaServerBaseUrl,
  parseLlamaServerSettings,
  type LlamaServerSettings,
} from "@/lib/llama-server-settings";

export const LLAMA_SERVER_PROVIDER_ID = "llama-server";
export const DEFAULT_LLAMA_SERVER_BASE = llamaServerBaseUrl(
  process.env.LEAFCODE_PI_LLAMA_PORT,
);

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

export function displayName(id: string): string {
  const short = basename(id.replace(/\\/g, "/"));
  const name = short.toLowerCase().endsWith(".gguf")
    ? short.slice(0, -5)
    : short || id;
  if (name.toLowerCase() === "ternary-bonsai-2-27b-ptq1_0") {
    return "OrcaBonsai 27B Uncensored";
  }
  const shortened = name.replace(
    /(?:-(?:Q\d+_[A-Z](?:_[A-Z])?|IQ\d+_[A-Z]\d*|F\d+|BF16|FP\d+))+$/i,
    "",
  ) || name;
  return shortened.toLowerCase() === "qwen3.8-27b-uncensored"
    ? "Qwen3.8 27B Uncensored"
    : shortened;
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
 * llama-server has no process-wide system-prompt flag. Add the configured
 * prompt to the provider context so the OpenAI-compatible request sends it as
 * a system message on every call without replacing Pi's own instructions.
 */
export function appendLlamaServerSystemPrompt(
  context: TranscriptContext,
  systemPrompt: string,
): TranscriptContext {
  const addition = systemPrompt.trim();
  if (!addition) return context;
  // Pi 0.86 passes a normalized transcript to custom providers. Append through
  // the transcript replay path so prompt/tool updates are not lost.
  return collapseSystemMessages({
    ...context,
    messages: [
      ...context.messages,
      { role: "system", content: addition, timestamp: 0 },
    ],
  });
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
 * `image` comes from the OpenAI-compatible capabilities list, which contains
 * "multimodal" only while a vision projector (mmproj) is loaded. llama-server
 * は `data[]`（id/status 用、capabilities なし）と `models[]`（capabilities あり）
 * の両方を返すので、 id でマージして読む。
 */
export type LlamaServerModelEntry = { id: string; status: string; image: boolean };

function readLlamaServerRow(row: unknown): LlamaServerModelEntry | null {
  if (!row || typeof row !== "object") return null;
  const record = row as {
    id?: unknown;
    name?: unknown;
    model?: unknown;
    status?: { value?: unknown };
    capabilities?: unknown;
  };
  const idValue = [record.id, record.name, record.model].find(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  );
  if (!idValue) return null;
  const status =
    record.status && typeof record.status === "object"
      ? String(record.status.value ?? "")
      : "";
  const rawCapabilities = record.capabilities;
  const capabilities = Array.isArray(rawCapabilities)
    ? rawCapabilities.filter((value): value is string => typeof value === "string")
    : [];
  return { id: idValue.trim(), status, image: capabilities.includes("multimodal") };
}

export async function fetchLlamaServerModels(
  baseUrl = DEFAULT_LLAMA_SERVER_BASE,
): Promise<LlamaServerModelEntry[]> {
  const root = baseUrl.replace(/\/$/, "").replace(/\/v1$/i, "");
  for (const path of ["/models", "/v1/models"]) {
    try {
      const res = await fetch(`${root}${path}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { models?: unknown; data?: unknown };
      const dataRows = Array.isArray(body.data) ? body.data : [];
      const catalogRows = Array.isArray(body.models) ? body.models : [];
      if (dataRows.length === 0 && catalogRows.length === 0) continue;
      const byId = new Map<string, LlamaServerModelEntry>();
      for (const row of dataRows) {
        const entry = readLlamaServerRow(row);
        if (entry) byId.set(entry.id, entry);
      }
      for (const row of catalogRows) {
        const entry = readLlamaServerRow(row);
        if (!entry) continue;
        const previous = byId.get(entry.id);
        byId.set(entry.id, {
          id: entry.id,
          status: previous?.status || entry.status,
          image: (previous?.image ?? false) || entry.image,
        });
      }
      const rows = [...byId.values()];
      if (rows.length === 0) continue;
      const loaded = rows.filter((r) => r.status === "loaded");
      if (loaded.length > 0) return loaded;
      // Unloaded-only catalog: still return ids so sync can run after ensure-loaded.
      return rows;
    } catch {
      /* try next path / fall through */
    }
  }
  return [];
}

function buildModelRows(entries: LlamaServerModelEntry[], contextWindow: number): OpenAiModelRow[] {
  return entries.map((entry) => {
    const id = entry.id;
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
      // mmproj ロード中のみ llmama-server は "multimodal" を報告する。
      // ここを落とすと Pi が送信時に画像をプレースホルダへ置換する。
      input: entry.image ? ["text", "image"] : (["text"] as ("text" | "image")[]),
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
  const live = await fetchLlamaServerModels(DEFAULT_LLAMA_SERVER_BASE);
  if (live.length > 0) return buildModelRows(live, contextWindow);
  // 停止中（または /models 無応答）はモデルを1つも登録しない。modelFile からの推測 id を
  // 残すと、停止した llama-server がドロップダウンに選択できない項目として残る。
  return [];
}

function llamaStreamSimple(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) {
  const previous = options?.onPayload;
  const settings = parseLlamaServerSettings(readSettingValue(LLAMA_SERVER_SETTINGS_KEY));
  const requestContext = appendLlamaServerSystemPrompt(context, settings.systemPrompt);
  return streamSimple(model, requestContext, {
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
