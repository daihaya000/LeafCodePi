import {
  abortTaskOnBackend,
  controlGoalLoopOnBackend,
  createBotCodeSessionOnBackend,
  type BackendGoalLoopBody,
  postBotCodeRequestAction,
  promptTaskOnBackend,
  readBackendPendingSnapshots,
  readBackendTaskDetail,
  respondPermissionOnBackend,
  respondQuestionOnBackend,
  type BackendEnv,
  type BackendFailureReason,
} from "@/lib/backend-client";
import type { PermissionRequestDto, QuestionRequestDto } from "@/lib/types";

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

/**
 * The pending approval/question the owning Backend is waiting on for a task.
 *
 * The requests live in the owner's memory, so a WebUI that does not own the session must ask the
 * Backend for them; without this the approval prompt would never appear after the cutover. A read
 * failure is reported as "nothing pending" so a stream keeps working, but the caller may retry.
 */
export async function forwardTaskPendingRequests(
  id: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ permissionRequest: unknown; questionRequest: unknown }> {
  const result = await readBackendPendingSnapshots(options);
  if (!result.ok) return { permissionRequest: null, questionRequest: null };
  const entry = (result.body?.snapshots ?? []).find((snapshot) => snapshot?.taskId === id);
  const payload = entry?.payload;
  const fields = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return {
    permissionRequest: fields.permissionRequest ?? null,
    questionRequest: fields.questionRequest ?? null,
  };
}

/**
 * The pending requests of every task the owning Backend is waiting on, keyed by task id. The Backend
 * emits the same DTOs the WebUI renders, so the values are read as those types.
 */
export type PendingRequestsByTask = Record<
  string,
  { permissionRequest: PermissionRequestDto | null; questionRequest: QuestionRequestDto | null }
>;

/**
 * One read for every pending request, for callers that need several tasks at once (a Room, a panel).
 * A failed read is an empty map: the caller keeps working and the next poll retries.
 */
export async function forwardPendingRequestsByTask(
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PendingRequestsByTask> {
  const result = await readBackendPendingSnapshots(options);
  if (!result.ok) return {};
  const byTask: PendingRequestsByTask = {};
  for (const snapshot of result.body?.snapshots ?? []) {
    const taskId = snapshot?.taskId;
    if (typeof taskId !== "string" || !taskId) continue;
    const payload = snapshot?.payload;
    const fields = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    byTask[taskId] = {
      permissionRequest: (fields.permissionRequest as PermissionRequestDto | null | undefined) ?? null,
      questionRequest: (fields.questionRequest as QuestionRequestDto | null | undefined) ?? null,
    };
  }
  return byTask;
}

/** Stops a Bot Code request in the owning Backend; the outbox write happens there. */
export async function forwardBotCodeRequestAbort(
  botId: string,
  requestId: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; result: { requestId: string; state: string; task?: Record<string, unknown> } }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await postBotCodeRequestAction(botId, { action: "abort", requestId }, options);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  return { ok: true, result: result.body };
}

/** Starts a Goal Loop in the owner, including Auto/model/agent selection and rollback. */
export async function forwardGoalLoopStart(
  id: string,
  body: Omit<Extract<BackendGoalLoopBody, { action: "start" }>, "action">,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; loop: Record<string, unknown> | null; agent: string | null; autoDecision?: Record<string, unknown> }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await controlGoalLoopOnBackend(
    id,
    {
      action: "start",
      ...(body.botId !== undefined ? { botId: body.botId } : {}),
      goal: body.goal,
      acceptance: body.acceptance,
      ...(body.maxTurns !== undefined ? { maxTurns: body.maxTurns } : {}),
      ...(body.cooldownSeconds !== undefined ? { cooldownSeconds: body.cooldownSeconds } : {}),
      ...(body.forceFullRun !== undefined ? { forceFullRun: body.forceFullRun } : {}),
      ...(body.images !== undefined ? { images: body.images } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.thinkingLevel !== undefined ? { thinkingLevel: body.thinkingLevel } : {}),
      ...(body.agent !== undefined ? { agent: body.agent } : {}),
      ...(body.auto !== undefined ? { auto: body.auto } : {}),
      ...(body.autoOptimize !== undefined ? { autoOptimize: body.autoOptimize } : {}),
      ...(body.autoRouteOverrides !== undefined ? { autoRouteOverrides: body.autoRouteOverrides } : {}),
    },
    // Auto agent selection alone may take 30s: the normal 10s read timeout is too short.
    { ...options, timeoutMs: options.timeoutMs ?? 60_000 },
  );
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  const loop = result.body?.loop;
  return {
    ok: true,
    loop: loop && typeof loop === "object" ? loop : null,
    agent: typeof result.body?.agent === "string" ? result.body.agent : null,
    ...(result.body?.autoDecision ? { autoDecision: result.body.autoDecision } : {}),
  };
}

/** Controls a Goal Loop in the owning Backend; a missing loop is a 404, not a fallback. */
export async function forwardGoalLoopControl(
  id: string,
  body: Extract<BackendGoalLoopBody, { action: "pause" | "resume" | "stop" | "complete" }>,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; loop: Record<string, unknown> | null }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await controlGoalLoopOnBackend(id, body, options);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  const loop = result.body?.loop;
  return { ok: true, loop: loop && typeof loop === "object" ? loop : null };
}

/** Starts a Bot Code session in the owning Backend. Never falls back to a local start. */
export async function forwardBotCodeSessionStart(
  botId: string,
  input: Record<string, unknown>,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; task: Record<string, unknown> | null }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await createBotCodeSessionOnBackend(botId, input, options);
  if (!result.ok) {
    // 404 means the session the caller asked to continue no longer exists.
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  const task = result.body?.task;
  return { ok: true, task: task && typeof task === "object" ? task : null };
}
