import {
  abortCompactTaskOnBackend,
  abortTaskOnBackend,
  compactTaskOnBackend,
  controlGoalLoopOnBackend,
  createBotCodeSessionOnBackend,
  type BackendGoalLoopBody,
  postBotCodeRequestAction,
  promptRoomOnBackend,
  promptTaskOnBackend,
  readBackendAttention,
  readBackendPendingSnapshots,
  readBackendTaskDetail,
  respondPermissionOnBackend,
  respondQuestionOnBackend,
  revertBotTaskOnBackend,
  revertRoomOnBackend,
  revertTaskOnBackend,
  botAdminOnBackend,
  reloadLiveSessionsOnBackend,
  taskAdminOnBackend,
  teardownProjectOnBackend,
  teardownTaskOnBackend,
  roomAdminOnBackend,
  runBotRoutineOnBackend,
  setTaskAgentOnBackend,
  setTaskModelOnBackend,
  setTaskThinkingLevelOnBackend,
  unrevertTaskOnBackend,
  type BackendEnv,
  type BackendFailureReason,
  type BackendResult,
} from "@/lib/backend-client";
import type { PermissionRequestDto, QuestionRequestDto, RoomFile, RoomImage } from "@/lib/types";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";

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
  "auto", "autoRetry", "autoOptimize", "autoRouteOverrides",
] as const;

/** Selection fields resolved by the owner; retained for callers identifying selection requests. */
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
  | { ok: true; task: Record<string, unknown> | null; result?: { status: number; body: Record<string, unknown> } }
  | { ok: false; reason: BackendFailureReason; status?: number };

/** Starts the session in the owning Backend. Never falls back to the in-process path. */
export async function forwardTaskPrompt(
  id: string,
  body: Record<string, unknown> | null | undefined,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ForwardedPromptResult> {
  const result = await promptTaskOnBackend(id, forwardablePromptBody(body), {
    ...options, timeoutMs: options.timeoutMs ?? (body?.auto === true || body?.agent === AUTO_AGENT_VALUE ? 180_000 : undefined),
  });
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  if (result.body?.result !== undefined) {
    const answer = result.body.result;
    if (!answer || !Number.isInteger(answer.status) || answer.status < 200 || answer.status > 599 || !answer.body || typeof answer.body !== "object" || Array.isArray(answer.body)) {
      return { ok: false, reason: "bad-response", status: 502 };
    }
    const task = answer.body.task;
    return { ok: true, task: task && typeof task === "object" ? task as Record<string, unknown> : null, result: answer };
  }
  const task = result.body?.task;
  return { ok: true, task: task && typeof task === "object" ? task : null };
}

export type ForwardedDetailResult =
  | { ok: true; detail: Record<string, unknown> | null }
  | { ok: false; reason: BackendFailureReason | "not-found" | "invalid-cursor"; status?: number };

/** Reads a task's detail from the owning Backend. Never falls back to the in-process read. */
export async function forwardTaskDetail(
  id: string,
  options: NonNullable<Parameters<typeof readBackendTaskDetail>[1]> = {},
): Promise<ForwardedDetailResult> {
  const result = await readBackendTaskDetail(id, options);
  // 404 is the Backend's answer ("no such task"), not a transport failure.
  if (!result.ok && result.status === 404) return { ok: false, reason: "not-found", status: 404 };
  if (!result.ok && options.messages === "page" && result.status === 409 && result.reason === "bad-response") {
    return { ok: false, reason: "invalid-cursor", status: 409 };
  }
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
 * The owner's attention list. A failed read is reported, never answered with the local memory: the
 * WebUI that does not own the sessions has none.
 */
export async function forwardPendingAttention(
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; items: Array<Record<string, unknown>> }
  | { ok: false; reason: BackendFailureReason; status?: number }
> {
  const result = await readBackendAttention(options);
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  return { ok: true, items: Array.isArray(result.body?.items) ? result.body.items : [] };
}

/**
 * The pending approval/question the owning Backend is waiting on for a task.
 *
 * The requests live in the owner's memory, so a WebUI that does not own the session must ask the
 * Backend for them; without this the approval prompt would never appear after the cutover.
 * Transport failure is reported as `ok: false` so callers can keep the last known pending UI
 * instead of flashing an empty approval state.
 */
export async function forwardTaskPendingRequests(
  id: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; permissionRequest: unknown; questionRequest: unknown }
  | { ok: false; reason: BackendFailureReason; status?: number }
> {
  const result = await readBackendPendingSnapshots(options);
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  const entry = (result.body?.snapshots ?? []).find((snapshot) => snapshot?.taskId === id);
  const payload = entry?.payload;
  const fields = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return {
    ok: true,
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

/**
 * Changes a Room or deletes it in the owning Backend. The owner's answer keeps its own status and
 * body, so a refusal (bad settings, a missing room) is not reported as a transport failure.
 */
export async function forwardRoomAdmin(
  method: "PATCH" | "DELETE",
  roomId: string,
  body: Record<string, unknown> | null,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; result: { status: number; body: unknown } }
  | { ok: false; reason: BackendFailureReason; status?: number }
> {
  const result = await roomAdminOnBackend(method, roomId, body, options);
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  const nested = result.body?.result;
  return {
    ok: true,
    result: {
      status: Number.isInteger(nested?.status) ? nested.status : 200,
      body: nested?.body ?? null,
    },
  };
}

/**
 * Posts a Room turn in the owning Backend. The owner's answer keeps its own status and body, so a
 * refusal (a bad envelope, an oversized prompt) is not reported as a transport failure.
 */
export async function forwardRoomPrompt(
  roomId: string,
  body: Record<string, unknown> | null,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; result: { status: number; body: unknown } }
  | { ok: false; reason: BackendFailureReason; status?: number }
> {
  const result = await promptRoomOnBackend(roomId, body ?? {}, options);
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  const nested = result.body?.result;
  return {
    ok: true,
    result: {
      status: Number.isInteger(nested?.status) ? nested.status : 200,
      body: nested?.body ?? null,
    },
  };
}

/** A live-session setting the owner must apply; `field` is the body key the Backend reads. */
async function forwardSessionSetting(
  id: string,
  send: (options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number }) => Promise<BackendResult<{ task: Record<string, unknown> | null }>>,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; task: Record<string, unknown> | null }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await send(options);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  const task = result.body?.task;
  return { ok: true, task: task && typeof task === "object" ? task : null };
}

/** Changes a task's model in the owning Backend. Never falls back to the in-process session. */
export function forwardTaskModel(
  id: string,
  model: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
) {
  return forwardSessionSetting(id, (request) => setTaskModelOnBackend(id, model, request), options);
}

/** Changes a task's thinking level in the owning Backend. */
export function forwardTaskThinking(
  id: string,
  thinkingLevel: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
) {
  return forwardSessionSetting(id, (request) => setTaskThinkingLevelOnBackend(id, thinkingLevel, request), options);
}

/** Changes (or clears) a task's agent in the owning Backend. */
export function forwardTaskAgent(
  id: string,
  agent: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
) {
  return forwardSessionSetting(id, (request) => setTaskAgentOnBackend(id, agent, request), options);
}

/** Compaction runs an LLM inside the owner's session; the ordinary 10s read deadline is too short. */
export const COMPACT_FORWARD_TIMEOUT_MS = 300_000;

/** Compacts a task in the owning Backend. Never falls back to the in-process compaction. */
export async function forwardTaskCompact(
  id: string,
  customInstructions?: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; task: Record<string, unknown> | null }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await compactTaskOnBackend(id, customInstructions, {
    ...options,
    timeoutMs: options.timeoutMs ?? COMPACT_FORWARD_TIMEOUT_MS,
  });
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  const task = result.body?.task;
  return { ok: true, task: task && typeof task === "object" ? task : null };
}

/** Stops a running compaction in the owning Backend. */
export async function forwardTaskCompactAbort(
  id: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; task: Record<string, unknown> | null }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await abortCompactTaskOnBackend(id, options);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  const task = result.body?.task;
  return { ok: true, task: task && typeof task === "object" ? task : null };
}

/** Rewinds a task's transcript in the owning Backend. Never falls back to the in-process rewind. */
export async function forwardTaskRevert(
  id: string,
  entryId: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await revertTaskOnBackend(id, entryId, options);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  return { ok: true, result: result.body ?? {} };
}

/** Rebuilds live sessions after a settings change in the owning Backend; the owner's result comes back as-is. */
export async function forwardLiveSessionsReload(
  request: { action: "reload" } | { action: "refresh-agent"; agentName: string },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; result: unknown }
  | { ok: false; reason: BackendFailureReason; status?: number }
> {
  const result = await reloadLiveSessionsOnBackend(request, options);
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  return { ok: true, result: result.body?.result ?? null };
}

/**
 * Moves a task or hands it to / back from a Bot in the owning Backend. The owner's own status and
 * body come back unchanged so the WebUI can replay its messages.
 */
export async function forwardTaskAdmin(
  id: string,
  request: { action: "promote"; destinationPath: string } | { action: "fork"; entryId: string } | { action: "handoff"; botId: string } | { action: "release" },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; status: number; body: unknown }
  | { ok: false; reason: BackendFailureReason; status?: number }
> {
  const result = await taskAdminOnBackend(id, request, options);
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  const answer = result.body?.result;
  if (!answer || typeof answer.status !== "number") return { ok: false, reason: "bad-response" };
  return { ok: true, status: answer.status, body: answer.body };
}

/**
 * Changes or deletes a Bot in the owning Backend. The owner's own status and body come back
 * unchanged so the WebUI can replay its messages.
 */
export async function forwardBotAdmin(
  botId: string,
  request: { action: "patch"; body: unknown } | { action: "delete" },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; status: number; body: unknown }
  | { ok: false; reason: BackendFailureReason; status?: number }
> {
  const result = await botAdminOnBackend(botId, request, options);
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  const answer = result.body?.result;
  if (!answer || typeof answer.status !== "number") return { ok: false, reason: "bad-response" };
  return { ok: true, status: answer.status, body: answer.body };
}

/**
 * Archives, deletes or moves a project in the owning Backend. The owner's own status and body come
 * back unchanged so the WebUI can replay its messages.
 */
export async function forwardProjectTeardown(
  id: string,
  request: { action: "archive" | "destroy" | "migrate"; destinationPath?: string },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; status: number; body: unknown }
  | { ok: false; reason: BackendFailureReason; status?: number }
> {
  const result = await teardownProjectOnBackend(id, request, options);
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  const answer = result.body?.result;
  if (!answer || typeof answer.status !== "number") return { ok: false, reason: "bad-response" };
  return { ok: true, status: answer.status, body: answer.body };
}

/** Archives or deletes a task in the owning Backend, which stops its running session first. */
export async function forwardTaskTeardown(
  id: string,
  mode: "archive" | "destroy",
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; result: Record<string, unknown> | null }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await teardownTaskOnBackend(id, mode, options);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  return { ok: true, result: result.body?.result ?? null };
}

/** Restores the leaf after a rewind in the owning Backend. */
export async function forwardTaskUnrevert(
  id: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; task: Record<string, unknown> | null }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await unrevertTaskOnBackend(id, options);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  const task = result.body?.task;
  return { ok: true, task: task && typeof task === "object" ? task : null };
}

/** Rewinds a Room conversation in the owning Backend. Never falls back to the in-process rewind. */
export async function forwardRoomRevert(
  roomId: string,
  messageId: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; result: { text: string; images: RoomImage[]; files: RoomFile[]; cancelledCodeRequests: number } }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await revertRoomOnBackend(roomId, messageId, options);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  const body = (result.body ?? {}) as {
    text?: unknown; images?: unknown; files?: unknown; cancelledCodeRequests?: unknown;
  };
  return {
    ok: true,
    result: {
      text: typeof body.text === "string" ? body.text : "",
      images: Array.isArray(body.images) ? (body.images as RoomImage[]) : [],
      files: Array.isArray(body.files) ? (body.files as RoomFile[]) : [],
      cancelledCodeRequests: typeof body.cancelledCodeRequests === "number" ? body.cancelledCodeRequests : 0,
    },
  };
}

/** Rewinds a Bot conversation in the owning Backend. Never falls back to the in-process rewind. */
export async function forwardBotRevert(
  botId: string,
  entryId: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await revertBotTaskOnBackend(botId, entryId, options);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  return { ok: true, result: result.body ?? {} };
}

/** Runs a Bot routine in the owning Backend. Never falls back to the in-process run. */
export async function forwardBotRoutineRun(
  botId: string,
  routineId: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { ok: true; routine: Record<string, unknown> | null }
  | { ok: false; reason: BackendFailureReason | "not-found"; status?: number }
> {
  const result = await runBotRoutineOnBackend(botId, routineId, options);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, reason: "not-found", status: 404 };
    return { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }
  const routine = result.body?.routine;
  return { ok: true, routine: routine && typeof routine === "object" ? routine : null };
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
