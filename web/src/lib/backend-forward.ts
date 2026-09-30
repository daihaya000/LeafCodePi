import {
  abortTaskOnBackend,
  promptTaskOnBackend,
  readBackendTaskDetail,
  respondPermissionOnBackend,
  respondQuestionOnBackend,
  type BackendEnv,
  type BackendFailureReason,
} from "@/lib/backend-client";

/**
 * Forwarding a prompt to the Backend that owns the runtime.
 *
 * After the cutover the WebUI must not start a session itself, and it must not quietly fall back to the
 * in-process path when the Backend cannot answer: two owners would double-write the store, and a silent
 * fallback would hide a broken cutover. A failure is reported to the caller as a failure.
 */

/** The parts of the WebUI prompt body the Backend's runtime understands. */
const FORWARDED_FIELDS = [
  "prompt",
  "images",
  "files",
  "model",
  "thinkingLevel",
  "agent",
  "streamingBehavior",
  "resume",
] as const;

/** Fields the WebUI resolves before sending (Auto selection). Forwarding them would be meaningless. */
const WEBUI_ONLY_FIELDS = ["auto", "autoRetry", "autoOptimize", "autoRouteOverrides"] as const;

/** Whether this body needs WebUI-side resolution before it can be forwarded. */
export function needsLocalResolution(body: Record<string, unknown> | null | undefined): boolean {
  if (!body) return false;
  return WEBUI_ONLY_FIELDS.some((field) => body[field] !== undefined);
}

/** The subset of the request body the Backend's runtime accepts, dropping undefined fields. */
export function forwardablePromptBody(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const forwarded: Record<string, unknown> = {};
  for (const field of FORWARDED_FIELDS) {
    if (body?.[field] !== undefined) forwarded[field] = body[field];
  }
  return forwarded;
}

export type ForwardedPromptResult =
  | { ok: true; task: Record<string, unknown> | null }
  | { ok: false; reason: BackendFailureReason; status?: number };

/** Starts the session in the owning Backend. Never falls back to the in-process path. */
export async function forwardTaskPrompt(
  id: string,
  body: Record<string, unknown> | null | undefined,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ForwardedPromptResult> {
  const result = await promptTaskOnBackend(id, forwardablePromptBody(body), options);
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  const task = result.body?.task;
  return { ok: true, task: task && typeof task === "object" ? task : null };
}

export type ForwardedDetailResult =
  | { ok: true; detail: Record<string, unknown> | null }
  | { ok: false; reason: BackendFailureReason; status?: number };

/** Reads a task's detail from the owning Backend. Never falls back to the in-process read. */
export async function forwardTaskDetail(
  id: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ForwardedDetailResult> {
  const result = await readBackendTaskDetail(id, options);
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  const detail = result.body?.detail;
  return { ok: true, detail: detail && typeof detail === "object" ? detail : null };
}

/** The answer to a pending request: the owner knows whether the request was still waiting. */
export type ForwardedAnswerResult =
  | { ok: true }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number };

function answerResult(result: { ok: true; status: number } | { ok: false; reason: BackendFailureReason; status?: number }): ForwardedAnswerResult {
  if (result.ok) return { ok: true };
  // 404 means the request is no longer pending: that is an answer, not a transport failure.
  if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
  return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
}

/** Answers a pending approval in the owning Backend. */
export async function forwardPermissionAnswer(
  id: string,
  body: { requestId: string; approved: boolean },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ForwardedAnswerResult> {
  return answerResult(await respondPermissionOnBackend(id, body, options));
}

/** Answers a pending question in the owning Backend. */
export async function forwardQuestionAnswer(
  id: string,
  body: { requestId: string; answer?: unknown },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ForwardedAnswerResult> {
  return answerResult(await respondQuestionOnBackend(id, body, options));
}

/** Stops a session in the owning Backend. Never falls back to the in-process abort. */
export async function forwardTaskAbort(
  id: string,
  options: { botId?: string; env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: true; task: Record<string, unknown> | null } | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }> {
  const { botId, ...request } = options;
  const result = await abortTaskOnBackend(id, botId ? { botId } : {}, request);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  const task = result.body?.task;
  return { ok: true, task: task && typeof task === "object" ? task : null };
}
