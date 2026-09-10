import { completeModelText } from "@/lib/pi/harness";
import { listAccounts } from "@/lib/accounts";
import { splitGenerationModel } from "@/lib/generation-model-key";
import {
  DEFAULT_LLAMA_SERVER_BASE,
  isLlamaOrnithModel,
  isLlamaQwenReasoningModel,
  LLAMA_SERVER_PROVIDER_ID,
  rewriteLlamaServerEffortPayload,
} from "@/lib/pi/llama-provider";
import { isThinkingLevel } from "@/lib/thinking-levels";
import type { ThinkingLevel } from "@/lib/types";

const MAX_PROVIDER_ID_CHARS = 100;
const MAX_MODEL_ID_CHARS = 200;
const MAX_INPUT_CHARS = 120_000;
const MAX_OUTPUT_CHARS = 4_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export type DirectModel = {
  providerID: string;
  modelID: string;
  accountId?: string;
};

export type DirectGenerationCandidate = {
  model: DirectModel;
  effort?: string;
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
  const accountId =
    typeof value.accountId === "string" && value.accountId.trim()
      ? value.accountId.trim()
      : undefined;
  return typeof value.providerID === "string" && typeof value.modelID === "string"
    ? {
        providerID: value.providerID,
        modelID: value.modelID,
        ...(accountId ? { accountId } : {}),
      }
    : undefined;
}

export function parseDirectModelKey(value: unknown): DirectModel | undefined {
  const parsed = splitGenerationModel(value, listAccounts().map((account) => account.id));
  return parsed ? { ...parsed } : undefined;
}

function safeProviderId(value: string): string {
  const providerID = value.trim();
  if (
    !providerID ||
    providerID.length > MAX_PROVIDER_ID_CHARS ||
    providerID.includes("::") ||
    /[\u0000-\u001f\u007f]/.test(providerID)
  ) {
    throw new DirectGenerationError("プロバイダーIDが不正です", 400);
  }
  return providerID;
}

function runtimeReasoningForEffort(
  effort: string | undefined,
): Exclude<ThinkingLevel, "off"> | undefined {
  return isThinkingLevel(effort) && effort !== "off" ? effort : undefined;
}

function llamaEffortForModel(modelID: string, effort: string | undefined): string | undefined {
  if (!isThinkingLevel(effort)) return undefined;
  if (isLlamaOrnithModel(modelID)) {
    if (effort === "minimal") return "no_think";
    if (effort === "off") return "none";
  }
  return effort === "off" ? "none" : effort;
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

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Extract text from an OpenAI-compatible chat-completions response. */
function truncateOutputText(text: string): string {
  const trimmed = text.trim();
  // コードポイント単位で切る（絵文字などのサロゲートペアを壊さない）。
  return trimmed.length > MAX_OUTPUT_CHARS
    ? Array.from(trimmed).slice(0, MAX_OUTPUT_CHARS).join("")
    : trimmed;
}

export function extractDirectText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.choices)) return "";
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return "";
  return truncateOutputText(textFromContent(choice.message.content));
}

export async function generateDirectText(options: {
  model: DirectModel;
  /** Account runtime for account-scoped models; null/undefined uses default. */
  accountId?: string | null;
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  effort?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const system = options.system.trim();
  const prompt = options.prompt.trim();
  if (!system || !prompt) throw new DirectGenerationError("生成プロンプトが空です", 400);
  if (system.length + prompt.length > MAX_INPUT_CHARS) {
    throw new DirectGenerationError("生成プロンプトが長すぎます", 413);
  }

  const model = {
    providerID: safeProviderId(options.model.providerID),
    modelID: safeModelId(options.model.modelID),
    ...(options.model.accountId ? { accountId: options.model.accountId } : {}),
  };
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
    // Pi's runtime owns auth and API adapters for every registered provider. This
    // keeps custom/API/OAuth providers direct without accepting a browser URL.
    if (model.providerID !== LLAMA_SERVER_PROVIDER_ID) {
      const reasoning = runtimeReasoningForEffort(options.effort);
      const text = await completeModelText({
        ...model,
        ...(model.accountId ?? options.accountId
          ? { accountId: model.accountId ?? options.accountId }
          : {}),
        ...(model.accountId ? { accountIdExplicit: true } : {}),
        system,
        prompt,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        ...(reasoning ? { reasoning } : {}),
        signal: controller.signal,
      });
      return truncateOutputText(text);
    }

    const reasoning =
      isLlamaOrnithModel(model.modelID) || isLlamaQwenReasoningModel(model.modelID);
    const effort = reasoning ? llamaEffortForModel(model.modelID, options.effort) : undefined;
    const payload = {
      model: model.modelID,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: Math.min(2, Math.max(0, options.temperature ?? 0.2)),
      max_tokens: Math.min(1_024, Math.max(1, Math.floor(options.maxTokens ?? 256))),
      stream: false,
      ...(effort ? { reasoning_effort: effort } : {}),
    };
    const response = await fetch(`${DEFAULT_LLAMA_SERVER_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer local",
      },
      body: JSON.stringify(
        effort
          ? rewriteLlamaServerEffortPayload(payload, {
              id: model.modelID,
              reasoning,
            })
          : payload,
      ),
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

function isProviderInternalError(error: unknown): boolean {
  if (error instanceof DirectGenerationError && typeof error.status === "number") {
    return error.status === 500;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b500\s*:/.test(message);
}

export function sameDirectModel(a: DirectModel, b: DirectModel): boolean {
  return a.providerID === b.providerID && a.modelID === b.modelID && a.accountId === b.accountId;
}

export function buildDirectGenerationCandidates(options: {
  primary?: DirectModel;
  primaryEffort?: string;
  fallback?: DirectModel;
  fallbackEffort?: string;
}): DirectGenerationCandidate[] {
  const candidates: DirectGenerationCandidate[] = [];
  if (options.primary) {
    candidates.push({ model: options.primary, effort: options.primaryEffort });
  }
  if (options.fallback && (!options.primary || !sameDirectModel(options.primary, options.fallback))) {
    candidates.push({ model: options.fallback, effort: options.fallbackEffort });
  }
  return candidates;
}

export type DirectGenerationResult = {
  text: string;
  model: DirectModel;
};

type DirectGenerationFallbackOptions = Omit<Parameters<typeof generateDirectText>[0], "model" | "effort"> & {
  candidates: readonly DirectGenerationCandidate[];
};

export async function generateDirectTextWithFallbackResult(
  options: DirectGenerationFallbackOptions,
): Promise<DirectGenerationResult> {
  const { candidates, ...base } = options;
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return {
        text: await generateDirectText({
          ...base,
          model: candidate.model,
          effort: candidate.effort,
        }),
        model: candidate.model,
      };
    } catch (error) {
      lastError = error;
      if (base.signal?.aborted) throw error;
      if (candidate.effort && candidate.effort !== "off" && isProviderInternalError(error)) {
        try {
          return {
            text: await generateDirectText({ ...base, model: candidate.model }),
            model: candidate.model,
          };
        } catch (retryError) {
          lastError = retryError;
          if (base.signal?.aborted) throw retryError;
        }
      }
    }
  }
  throw lastError ?? new DirectGenerationError("生成モデルが設定されていません", 400);
}

export async function generateDirectTextWithFallback(
  options: DirectGenerationFallbackOptions,
): Promise<string> {
  return (await generateDirectTextWithFallbackResult(options)).text;
}
