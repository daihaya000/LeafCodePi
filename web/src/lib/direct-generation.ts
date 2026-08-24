import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_LLAMA_SERVER_BASE,
  LLAMA_SERVER_PROVIDER_ID,
} from "@/lib/pi/llama-provider";
import {
  DEFAULT_OLLAMA_CLOUD_BASE,
  OLLAMA_API_KEY_ENV,
  OLLAMA_CLOUD_PROVIDER_ID,
} from "@/lib/pi/ollama-cloud-provider";

const MAX_MODEL_ID_CHARS = 200;
const MAX_INPUT_CHARS = 120_000;
const MAX_OUTPUT_CHARS = 4_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export type DirectModel = {
  providerID: string;
  modelID: string;
};

type ResolvedDirectModel = DirectModel & {
  baseUrl: string;
  apiKey?: string;
};

export class DirectGenerationError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DirectGenerationError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDirectModel(value: unknown): DirectModel | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.providerID === "string" && typeof value.modelID === "string"
    ? { providerID: value.providerID, modelID: value.modelID }
    : undefined;
}

function safeModelId(value: string): string {
  const modelID = value.trim();
  if (
    !modelID ||
    modelID.length > MAX_MODEL_ID_CHARS ||
    /[\u0000-\u001f\u007f]/.test(modelID)
  ) {
    throw new DirectGenerationError("モデルIDが不正です", 400);
  }
  return modelID;
}

/** Resolve only literal/env API keys; never execute auth.json command values here. */
function resolveCredentialKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.startsWith("!")) return undefined;
  let missing = false;
  const resolved = value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare;
      const envValue = name ? process.env[name] : undefined;
      if (!envValue) {
        missing = true;
        return "";
      }
      return envValue;
    },
  );
  return missing ? undefined : resolved.trim() || undefined;
}

function storedApiKey(providerID: string): string | undefined {
  try {
    const credential = readStoredCredential(providerID);
    return credential?.type === "api_key" ? resolveCredentialKey(credential.key) : undefined;
  } catch {
    return undefined;
  }
}

function apiKeyFor(providerID: string, envName?: string): string | undefined {
  const fromEnv = envName ? process.env[envName]?.trim() : undefined;
  return fromEnv || storedApiKey(providerID);
}

/**
 * Resolve the small allowlist of providers supported by the direct path.
 * The URL is never accepted from the browser, which avoids turning this BFF
 * into an arbitrary server-side fetcher.
 */
export function resolveDirectModel(model: DirectModel): ResolvedDirectModel {
  const providerID = model.providerID.trim();
  const modelID = safeModelId(model.modelID);
  if (providerID === LLAMA_SERVER_PROVIDER_ID) {
    return {
      providerID,
      modelID,
      baseUrl: `${DEFAULT_LLAMA_SERVER_BASE}/v1`,
      apiKey: "local",
    };
  }
  if (providerID === OLLAMA_CLOUD_PROVIDER_ID) {
    const apiKey = apiKeyFor(providerID, OLLAMA_API_KEY_ENV);
    if (!apiKey) {
      throw new DirectGenerationError("Ollama Cloud のAPIキーが設定されていません", 401);
    }
    return { providerID, modelID, baseUrl: DEFAULT_OLLAMA_CLOUD_BASE, apiKey };
  }
  throw new DirectGenerationError(`直接生成に未対応のプロバイダーです: ${providerID}`, 400);
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Extract text from an OpenAI-compatible chat-completions response. */
export function extractDirectText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.choices)) return "";
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return "";
  return textFromContent(choice.message.content).trim().slice(0, MAX_OUTPUT_CHARS);
}

export async function generateDirectText(options: {
  model: DirectModel;
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const system = options.system.trim();
  const prompt = options.prompt.trim();
  if (!system || !prompt) throw new DirectGenerationError("生成プロンプトが空です", 400);
  if (system.length + prompt.length > MAX_INPUT_CHARS) {
    throw new DirectGenerationError("生成プロンプトが長すぎます", 413);
  }

  const model = resolveDirectModel(options.model);
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.modelID,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature: Math.min(2, Math.max(0, options.temperature ?? 0.2)),
        max_tokens: Math.min(1_024, Math.max(1, Math.floor(options.maxTokens ?? 256))),
        stream: false,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new DirectGenerationError(
        `プロバイダー応答エラー (${response.status})`,
        response.status,
      );
    }
    const text = extractDirectText(body);
    if (!text) throw new DirectGenerationError("プロバイダーの応答にテキストがありません");
    return text;
  } catch (error) {
    if (error instanceof DirectGenerationError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new DirectGenerationError("直接生成がタイムアウトまたはキャンセルされました", 408);
    }
    throw new DirectGenerationError(
      `直接生成に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
