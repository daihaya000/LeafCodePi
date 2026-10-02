/**
 * Server-side client for the independent Backend process.
 *
 * This module is only imported by route handlers and other server code: the token lives in the
 * server environment and must never reach browser code. Every call is explicit about what went
 * wrong (not configured / unreachable / unauthorized / incompatible / timeout) so a route can
 * decide between falling back to the in-process path and reporting an error.
 */
import {
  isBackendGenerationCompatible,
  normalizeExpectedGeneration,
} from "@shared/backend-generation.mjs";
import {
  BACKEND_ERROR_CODES,
  BACKEND_ATTENTION_PATH,
  BACKEND_BOT_CODE_REQUESTS_SUFFIX,
  BACKEND_BOT_CODE_SESSIONS_SUFFIX,
  BACKEND_BOT_ADMIN_SUFFIX,
  BACKEND_LIVE_SESSIONS_RELOAD_PATH,
  BACKEND_MCP_SERVERS_PATH,
  BACKEND_MCP_AUTH_SUFFIX,
  BACKEND_BOT_REVERT_SUFFIX,
  BACKEND_BOT_ROUTINES_SEGMENT,
  BACKEND_BOTS_PATH,
  BACKEND_HEALTH_PATH,
  BACKEND_RUNTIME_CONTROL_PATH,
  BACKEND_PENDING_SNAPSHOTS_PATH,
  BACKEND_PROTOCOL_HEADER,
  BACKEND_PROTOCOL_VERSION,
  BACKEND_ROOM_ADMIN_PATH,
  BACKEND_ROOM_PROMPT_SUFFIX,
  BACKEND_ROOM_REVERT_SUFFIX,
  BACKEND_ROOMS_PATH,
  BACKEND_TASK_ABORT_SUFFIX,
  BACKEND_TASK_COMPACT_ABORT_SUFFIX,
  BACKEND_TASK_COMPACT_SUFFIX,
  BACKEND_TASK_AGENT_SUFFIX,
  BACKEND_TASK_DETAIL_SUFFIX,
  BACKEND_TASK_GOAL_LOOP_SUFFIX,
  BACKEND_TASK_MODEL_SUFFIX,
  BACKEND_TASK_THINKING_SUFFIX,
  BACKEND_TASK_PERMISSION_SUFFIX,
  BACKEND_TASK_QUESTION_SUFFIX,
  BACKEND_TASK_PROMPT_SUFFIX,
  BACKEND_TASK_REVERT_SUFFIX,
  BACKEND_PROJECT_TEARDOWN_SUFFIX,
  BACKEND_PROJECTS_PATH,
  BACKEND_TASK_ADMIN_SUFFIX,
  BACKEND_TASK_TEARDOWN_SUFFIX,
  BACKEND_TASK_UNREVERT_SUFFIX,
  BACKEND_TASKS_PATH,
  DEFAULT_BACKEND_PORT,
} from "@shared/backend-protocol.mjs";

import type { McpDto } from "@/lib/mcp";
import type { McpPresetRequest, McpPublicReload } from "@shared/mcp-preset-request.mjs";
import type { McpPublicAuthSnapshot } from "@shared/mcp-auth-snapshot.mjs";
import type { McpBearerSaveRequest, McpBearerSaveResult } from "@shared/mcp-bearer-save-request.mjs";
import type { McpHeadersSaveRequest, McpHeadersSaveResult } from "@shared/mcp-headers-save-request.mjs";

export const BACKEND_REQUEST_TIMEOUT_MS = 10_000;

export type BackendFailureReason =
  | "not-configured"
  | "unreachable"
  | "unauthorized"
  | "incompatible"
  | "timeout"
  | "bad-response";

export type BackendResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; reason: BackendFailureReason; status?: number; error?: string };

/** Keep only short Japanese owner messages; opaque Backend placeholders stay local. */
function clientFacingBackendError(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "string" || error.length === 0 || error.length >= 240) return undefined;
  if (error.startsWith("Backend ")) return undefined;
  if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(error)) return undefined;
  return error;
}

/** The environment the client reads; `process.env` satisfies it, and tests pass a literal. */
export type BackendEnv = Record<string, string | undefined>;

/** Where the Backend is and whether this process may talk to it. */
export function backendClientStatus(env: BackendEnv = process.env): {
  configured: boolean;
  url: string;
} {
  const token = env.LEAFCODE_PI_BACKEND_TOKEN?.trim();
  return { configured: Boolean(token), url: backendBaseUrl(env) };
}

export function backendBaseUrl(env: BackendEnv = process.env): string {
  const configured = env.LEAFCODE_PI_BACKEND_URL?.trim();
  const base = configured || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
  return base.replace(/\/+$/, "");
}

/**
/**
 * One authenticated call against the Backend. The request carries the protocol header, and the
 * response status decides the failure reason: 401/403 unauthorized, 409 incompatible, anything else
 * non-2xx is a bad response. Network errors and timeouts are separated so a caller can retry the
 * latter and treat the former as "Backend is down". The deadline covers headers and body reads.
 */
async function backendRequest<T>(
  path: string,
  options: {
    env?: BackendEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
  } = {},
): Promise<BackendResult<T>> {
  const env = options.env ?? process.env;
  const token = env.LEAFCODE_PI_BACKEND_TOKEN?.trim();
  if (!token) return { ok: false, reason: "not-configured" };
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? BACKEND_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const hasBody = options.body !== undefined;
  let response: Response | undefined;
  try {
    response = await doFetch(`${backendBaseUrl(env)}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${token}`,
        [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
      },
      cache: "no-store",
      signal: controller.signal,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized", status: response.status };
    if (response.status === 409) {
      try {
        const body = await response.json();
        if (body?.code === BACKEND_ERROR_CODES.badRequest || body?.code === BACKEND_ERROR_CODES.internal) {
          const error = clientFacingBackendError(body);
          return { ok: false, reason: "bad-response", status: 409, ...(error ? { error } : {}) };
        }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // An unrecognized conflict remains a protocol refusal, as with older Backends.
      }
      return { ok: false, reason: "incompatible", status: 409 };
    }
    if (!response.ok) {
      try {
        const body = await response.json();
        const error = clientFacingBackendError(body);
        return { ok: false, reason: "bad-response", status: response.status, ...(error ? { error } : {}) };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        return { ok: false, reason: "bad-response", status: response.status };
      }
    }
    return { ok: true, status: response.status, body: (await response.json()) as T };
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    return {
      ok: false,
      reason: aborted ? "timeout" : response ? "bad-response" : "unreachable",
      ...(response ? { status: response.status } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads only the owning process's auth status. No local bridge/config fallback. */
export function readMcpAuthStatusOnBackend(
  name: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<McpPublicAuthSnapshot>> {
  return backendRequest(`${BACKEND_MCP_SERVERS_PATH}/${encodeURIComponent(name)}${BACKEND_MCP_AUTH_SUFFIX}`, options);
}

/** Private bearer save payload goes only to the owner, never into a URL or local config. */
export function saveMcpBearerAuthOnBackend(
  name: string,
  input: McpBearerSaveRequest,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<McpBearerSaveResult>> {
  return backendRequest(`${BACKEND_MCP_SERVERS_PATH}/${encodeURIComponent(name)}${BACKEND_MCP_AUTH_SUFFIX}`, {
    ...options, method: "POST", body: input,
  });
}

/** Header values travel only in the private owner's POST body; no local fallback. */
export function saveMcpHeadersAuthOnBackend(
  name: string,
  input: McpHeadersSaveRequest,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<McpHeadersSaveResult>> {
  return backendRequest(`${BACKEND_MCP_SERVERS_PATH}/${encodeURIComponent(name)}${BACKEND_MCP_AUTH_SUFFIX}`, {
    ...options, method: "POST", body: input,
  });
}

export type BackendMcpEnabledResult = { ok: true; name: string; enabled: boolean; servers: McpDto[] };
export type BackendMcpPresetResult = { ok: true; name: McpPresetRequest["preset"]; servers: McpDto[]; reload: McpPublicReload };

/** Adds a known preset only in the owner; request credentials must not be logged. */
export function createMcpPresetOnBackend(
  input: McpPresetRequest,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<BackendMcpPresetResult>> {
  return backendRequest(BACKEND_MCP_SERVERS_PATH, { ...options, method: "POST", body: input });
}

/** Writes MCP ON/OFF only in the owner. No local fallback or path/config arguments. */
export function setMcpServerEnabledOnBackend(
  name: string,
  enabled: boolean,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<BackendMcpEnabledResult>> {
  return backendRequest(`${BACKEND_MCP_SERVERS_PATH}/${encodeURIComponent(name)}`, {
    ...options, method: "PATCH", body: { enabled },
  });
}

/** Read owner-scoped state without opening or driving a session. */
export function readBackendRuntimeState(options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<BackendResult<{ taskIds: string[] }>> {
  return backendRequest(BACKEND_RUNTIME_CONTROL_PATH, options);
}

export function controlBackendRuntime<T>(action: string, value?: unknown): Promise<BackendResult<{ result: T }>> {
  return backendRequest(BACKEND_RUNTIME_CONTROL_PATH, { method: "POST", body: { action, ...(value !== undefined ? { value } : {}) } });
}

/** The health fields this client relies on; the Backend may report more. */
export type BackendHealth = {
  ready: boolean;
  status: string;
  pid: number;
  protocolVersion?: number;
  instanceId?: string;
  startedAt?: string;
  /** The build id of the runtime the Backend attached; null while nothing is attached. */
  runtimeGeneration?: string | null;
  /** The build id the Host pinned when it started the Backend; null when it pinned none. */
  runtimeGenerationPinned?: string | null;
};

/** Whether the Backend process is up and has attached its runtime. */
export function readBackendHealth(options: Parameters<typeof fetchBackendJson>[1] = {}) {
  return fetchBackendJson<BackendHealth>(BACKEND_HEALTH_PATH, options);
}

/** One authenticated read against the Backend. */
export function fetchBackendJson<T>(
  path: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<T>> {
  return backendRequest<T>(path, { ...options, method: "GET" });
}

/** One authenticated write against the Backend. A failed call is a reason, never a local retry. */
export function postBackendJson<T>(
  path: string,
  body: unknown,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<T>> {
  return backendRequest<T>(path, { ...options, method: "POST", body });
}

/** One authenticated PATCH with a JSON body. */
export function patchBackendJson<T>(
  path: string,
  body: unknown,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<T>> {
  return backendRequest<T>(path, { ...options, method: "PATCH", body });
}

/** One authenticated DELETE without a body. */
export function deleteBackendJson<T>(
  path: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<T>> {
  return backendRequest<T>(path, { ...options, method: "DELETE" });
}

/** Creates and starts a task in the owning Backend. */
export function createTaskOnBackend(
  input: unknown,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ task: Record<string, unknown> | null }>> {
  return postBackendJson(BACKEND_TASKS_PATH, input, options);
}

/** Starts a session in the owning Backend: `POST /internal/tasks/:id/prompt`. */
export function promptTaskOnBackend(
  id: string,
  body: unknown,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ task?: Record<string, unknown> | null; result?: { status: number; body: Record<string, unknown> } }>> {
  return postBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_PROMPT_SUFFIX}`, body, options);
}

/**
 * The runtime generation the Host pinned when it started this Backend, if it recorded one.
 * Empty means "not pinned": this WebUI has no expectation to compare against.
 */
export function expectedBackendGeneration(env: BackendEnv = process.env): string {
  return normalizeExpectedGeneration(env.LEAFCODE_PI_BACKEND_GENERATION);
}

/** Start includes selection inputs: only the owning Backend resolves Auto and mutates settings. */
export type BackendGoalLoopBody =
  | {
      action: "start"; goal: string; acceptance: string[]; botId?: string;
      maxTurns?: number; cooldownSeconds?: number; forceFullRun?: boolean; images?: unknown;
      model?: string; thinkingLevel?: string; agent?: string;
      auto?: unknown; autoOptimize?: unknown; autoRouteOverrides?: unknown;
    }
  | { action: "pause" | "resume" | "stop" | "complete"; maxTurns?: number; botId?: string };

/** Starts or controls a Goal Loop in the owning Backend. */
export function controlGoalLoopOnBackend(
  id: string,
  body: BackendGoalLoopBody,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{
  loop: Record<string, unknown> | null;
  agent?: string | null;
  autoDecision?: Record<string, unknown>;
}>> {
  return postBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_GOAL_LOOP_SUFFIX}`, body, options);
}

/** Starts a Bot Code session in the owning Backend (the task row, its outbox entry and the session). */
export function createBotCodeSessionOnBackend(
  botId: string,
  input: Record<string, unknown>,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ task: Record<string, unknown> | null }>> {
  return postBackendJson(`${BACKEND_BOTS_PATH}/${encodeURIComponent(botId)}${BACKEND_BOT_CODE_SESSIONS_SUFFIX}`, input, options);
}

/** Changes the model of a task in the owning Backend (a running session is told there). */
export function setTaskModelOnBackend(
  id: string,
  model: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ task: Record<string, unknown> | null }>> {
  return postBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_MODEL_SUFFIX}`, { model }, options);
}

/** Changes the thinking level of a task in the owning Backend. */
export function setTaskThinkingLevelOnBackend(
  id: string,
  thinkingLevel: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ task: Record<string, unknown> | null }>> {
  return postBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_THINKING_SUFFIX}`, { thinkingLevel }, options);
}

/** Changes (or clears) the agent of a task in the owning Backend. */
export function setTaskAgentOnBackend(
  id: string,
  agent: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ task: Record<string, unknown> | null }>> {
  return postBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_AGENT_SUFFIX}`, { agent }, options);
}

/**
 * Compacts a task in the owning Backend. Summarization runs inside the session, so it can take
 * minutes: the caller passes a long timeout instead of the ordinary read deadline.
 */
export function compactTaskOnBackend(
  id: string,
  customInstructions: string | undefined,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ task: Record<string, unknown> | null }>> {
  return postBackendJson(
    `${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_COMPACT_SUFFIX}`,
    customInstructions === undefined ? {} : { customInstructions },
    options,
  );
}

/** Stops a running compaction in the owning Backend. */
export function abortCompactTaskOnBackend(
  id: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ task: Record<string, unknown> | null }>> {
  return postBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_COMPACT_ABORT_SUFFIX}`, {}, options);
}

/** Rewinds a task's transcript in the owning Backend: the session tree lives there. */
export function revertTaskOnBackend(
  id: string,
  entryId: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<Record<string, unknown>>> {
  return postBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_REVERT_SUFFIX}`, { entryId }, options);
}

/** Restores the leaf after a rewind in the owning Backend. */
export function unrevertTaskOnBackend(
  id: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ task: Record<string, unknown> | null }>> {
  return postBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_UNREVERT_SUFFIX}`, {}, options);
}

/** Rebuilds live sessions after a settings change in the owning Backend, which holds them. */
export function reloadLiveSessionsOnBackend(
  request: { action: "reload" } | { action: "refresh-agent"; agentName: string },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ result: unknown }>> {
  return postBackendJson(BACKEND_LIVE_SESSIONS_RELOAD_PATH, request, options);
}

/** Moves a task or hands it to / back from a Bot in the owning Backend, which holds the session. */
export function taskAdminOnBackend(
  id: string,
  request: { action: "promote"; destinationPath: string } | { action: "handoff"; botId: string } | { action: "release" },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ result: { status: number; body: unknown } }>> {
  return postBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_ADMIN_SUFFIX}`, request, options);
}

/** Changes or deletes a Bot in the owning Backend, which holds its conversations and Code sessions. */
export function botAdminOnBackend(
  botId: string,
  request: { action: "patch"; body: unknown } | { action: "delete" },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ result: { status: number; body: unknown } }>> {
  return postBackendJson(`${BACKEND_BOTS_PATH}/${encodeURIComponent(botId)}${BACKEND_BOT_ADMIN_SUFFIX}`, request, options);
}

/** Archives, deletes or moves a project in the owning Backend, which stops its sessions first. */
export function teardownProjectOnBackend(
  id: string,
  request: { action: "archive" | "destroy" | "migrate"; destinationPath?: string },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ result: { status: number; body: unknown } }>> {
  return postBackendJson(`${BACKEND_PROJECTS_PATH}/${encodeURIComponent(id)}${BACKEND_PROJECT_TEARDOWN_SUFFIX}`, request, options);
}

/** Archives or deletes a task in the owning Backend, which stops its running session first. */
export function teardownTaskOnBackend(
  id: string,
  mode: "archive" | "destroy",
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ result: Record<string, unknown> | null }>> {
  return postBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_TEARDOWN_SUFFIX}`, { mode }, options);
}

/**
 * Changes a Room or deletes it in the owning Backend. The teardown is owner work, so the answer is
 * `{ result: { status, body } }` with HTTP 200 and the WebUI replays it unchanged.
 */
export function roomAdminOnBackend(
  method: "PATCH" | "DELETE",
  roomId: string,
  body: Record<string, unknown> | null,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ result: { status: number; body: unknown } }>> {
  const path = `${BACKEND_ROOM_ADMIN_PATH}/${encodeURIComponent(roomId)}`;
  return method === "PATCH"
    ? patchBackendJson(path, body ?? {}, options)
    : deleteBackendJson(path, options);
}

/**
 * Posts a Room turn in the owning Backend. The owner runs the whole ladder, so the answer is
 * `{ result: { status, body } }` with HTTP 200 and the WebUI replays it unchanged.
 */
export function promptRoomOnBackend(
  roomId: string,
  body: Record<string, unknown>,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ result: { status: number; body: unknown } }>> {
  return postBackendJson(
    `${BACKEND_ROOMS_PATH}/${encodeURIComponent(roomId)}${BACKEND_ROOM_PROMPT_SUFFIX}`,
    body,
    options,
  );
}

/** Rewinds a Room conversation in the owning Backend: the turns, attention and outbox are there. */
export function revertRoomOnBackend(
  roomId: string,
  messageId: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<Record<string, unknown>>> {
  return postBackendJson(
    `${BACKEND_ROOMS_PATH}/${encodeURIComponent(roomId)}${BACKEND_ROOM_REVERT_SUFFIX}`,
    { messageId },
    options,
  );
}

/** Rewinds a Bot conversation in the owning Backend: the session rewrite happens there. */
export function revertBotTaskOnBackend(
  botId: string,
  entryId: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<Record<string, unknown>>> {
  return postBackendJson(
    `${BACKEND_BOTS_PATH}/${encodeURIComponent(botId)}${BACKEND_BOT_REVERT_SUFFIX}`,
    { entryId },
    options,
  );
}

/** Runs a Bot routine in the owning Backend: the run prompts a session, which only the owner may do. */
export function runBotRoutineOnBackend(
  botId: string,
  routineId: string,
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ routine: Record<string, unknown> | null }>> {
  return postBackendJson(
    `${BACKEND_BOTS_PATH}/${encodeURIComponent(botId)}/${BACKEND_BOT_ROUTINES_SEGMENT}/${encodeURIComponent(routineId)}`,
    {},
    options,
  );
}

/** Runs a Bot Code request action (stopping a request also updates the outbox) in the owning Backend. */
export function postBotCodeRequestAction(
  botId: string,
  body: { action: "abort"; requestId: string },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ requestId: string; state: string; task?: Record<string, unknown> }>> {
  return postBackendJson(
    `${BACKEND_BOTS_PATH}/${encodeURIComponent(botId)}${BACKEND_BOT_CODE_REQUESTS_SUFFIX}`,
    body,
    options,
  );
}

/** Stops a running session in the owning Backend; a Bot-owned task also marks its outbox. */
export function abortTaskOnBackend(
  id: string,
  body: { botId?: string } = {},
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ task: Record<string, unknown> | null }>> {
  return postBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_ABORT_SUFFIX}`, body, options);
}

/** Answers a pending approval in the owning Backend. */
export function respondPermissionOnBackend(
  id: string,
  body: { requestId: string; approved: boolean },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ ok: boolean }>> {
  return postBackendJson(
    `${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_PERMISSION_SUFFIX}`,
    body,
    options,
  );
}

/** Answers a pending question in the owning Backend; a missing answer means rejection. */
export function respondQuestionOnBackend(
  id: string,
  body: { requestId: string; answer?: unknown },
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ ok: boolean }>> {
  return postBackendJson(
    `${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_QUESTION_SUFFIX}`,
    body,
    options,
  );
}

/** The owner's attention list: tasks waiting on an approval or a question. */
export function readBackendAttention(
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ items: Array<Record<string, unknown>> }>> {
  return fetchBackendJson(BACKEND_ATTENTION_PATH, options);
}

/** The Backend's buffered pending snapshots: the pending approvals/questions it is waiting on. */
export function readBackendPendingSnapshots(
  options: { env?: BackendEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BackendResult<{ snapshots: Array<Record<string, unknown>> }>> {
  return fetchBackendJson(BACKEND_PENDING_SNAPSHOTS_PATH, options);
}

/** A task's detail as the owning Backend sees it (offline transcript read). */
export function readBackendTaskDetail(
  id: string,
  options: {
    env?: BackendEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    messages?: "page" | "omit";
    before?: string;
  } = {},
): Promise<BackendResult<{ detail: Record<string, unknown> | null }>> {
  const query = options.messages
    ? new URLSearchParams({
        messages: options.messages,
        ...(options.messages === "page" && options.before !== undefined ? { before: options.before } : {}),
      })
    : null;
  return fetchBackendJson(`${BACKEND_TASKS_PATH}/${encodeURIComponent(id)}${BACKEND_TASK_DETAIL_SUFFIX}${query ? `?${query}` : ""}`, options);
}

/** The Backend's own view of the Bot store. */
export function readBackendBots(options: Parameters<typeof fetchBackendJson>[1] = {}) {
  return fetchBackendJson<{ bots: Array<Record<string, unknown>> }>(BACKEND_BOTS_PATH, options);
}

/** The Backend's own view of the task store (stored rows, not the Web's derived summaries). */
export function readBackendTasks(options: Parameters<typeof fetchBackendJson>[1] = {}) {
  return fetchBackendJson<{ tasks: Array<Record<string, unknown>> }>(BACKEND_TASKS_PATH, options);
}

// The comparison itself is a shared contract: the Backend uses the same rule for readiness.
export { isBackendGenerationCompatible };
