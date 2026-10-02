import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { streamRuntimeEvents } from "./runtime-events.mjs";
import { parseMcpPresetRequest } from "../../shared/mcp-preset-request.mjs";
import { publicMcpAuthSnapshot } from "../../shared/mcp-auth-snapshot.mjs";
import { parseMcpBearerSaveRequest, publicMcpBearerSaveResult } from "../../shared/mcp-bearer-save-request.mjs";
import { parseMcpHeadersSaveRequest, publicMcpHeadersSaveResult } from "../../shared/mcp-headers-save-request.mjs";
import { parseMcpAuthRemoveRequest, publicMcpAuthRemoveResult } from "../../shared/mcp-auth-remove-request.mjs";
import { InvalidTaskMessageCursorError, pageTaskMessages } from "../../shared/task-history.mjs";
import {
  BACKEND_ERROR_CODES,
  BACKEND_HEALTH_PATH,
  BACKEND_RUNTIME_CONTROL_PATH,
  BACKEND_RUNTIME_EVENTS_PATH,
  BACKEND_LIVE_SESSIONS_RELOAD_PATH,
  BACKEND_MCP_MIGRATION_PATH,
  BACKEND_MCP_SERVERS_PATH,
  BACKEND_MCP_AUTH_SUFFIX,
  BACKEND_BOT_ADMIN_SUFFIX,
  BACKEND_BOT_CODE_REQUESTS_SUFFIX,
  BACKEND_BOT_CODE_SESSIONS_SUFFIX,
  BACKEND_BOT_REVERT_SUFFIX,
  BACKEND_BOT_ROUTINES_SEGMENT,
  BACKEND_ATTENTION_PATH,
  BACKEND_BOTS_PATH,
  BACKEND_PENDING_SNAPSHOTS_PATH,
  BACKEND_PROJECT_TEARDOWN_SUFFIX,
  BACKEND_PROJECTS_PATH,
  BACKEND_ROOM_PROMPT_SUFFIX,
  BACKEND_ROOM_REVERT_SUFFIX,
  BACKEND_ROOMS_PATH,
  BACKEND_PROTOCOL_HEADER,
  BACKEND_PROTOCOL_VERSION,
  BACKEND_TASK_ABORT_SUFFIX,
  BACKEND_TASK_ADMIN_SUFFIX,
  BACKEND_TASK_DETAIL_SUFFIX,
  BACKEND_TASK_GOAL_LOOP_SUFFIX,
  BACKEND_TASK_PERMISSION_SUFFIX,
  BACKEND_TASK_AGENT_SUFFIX,
  BACKEND_TASK_COMPACT_ABORT_SUFFIX,
  BACKEND_TASK_COMPACT_SUFFIX,
  BACKEND_TASK_MODEL_SUFFIX,
  BACKEND_TASK_QUESTION_SUFFIX,
  BACKEND_TASK_PROMPT_SUFFIX,
  BACKEND_TASK_REVERT_SUFFIX,
  BACKEND_TASK_TEARDOWN_SUFFIX,
  BACKEND_TASK_THINKING_SUFFIX,
  BACKEND_TASK_UNREVERT_SUFFIX,
  BACKEND_TASKS_PATH,
  DEFAULT_BACKEND_PORT,
} from "../../shared/backend-protocol.mjs";

/** Prefer a short Japanese client message; never forward English/provider exception text. */
function clientFacingActionError(error, fallback) {
  const status = typeof error?.status === "number" ? error.status : 500;
  const message = error instanceof Error ? error.message : "";
  const safe = status >= 400 && status < 500
    && message.length > 0 && message.length < 240
    && /[\u3040-\u30ff\u3400-\u9fff]/.test(message);
  if (safe) {
    return {
      status,
      body: {
        error: message,
        code: status === 404 ? BACKEND_ERROR_CODES.notFound : BACKEND_ERROR_CODES.badRequest,
      },
    };
  }
  return {
    status,
    body: { error: fallback, code: BACKEND_ERROR_CODES.internal },
  };
}

function tokenDigest(value) {
  return createHash("sha256").update(value).digest();
}

/** The largest prompt body the Backend accepts; attachments are already size-checked by the WebUI. */
export const BACKEND_PROMPT_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

/** The body field each live-session setting reads. */
const SETTING_FIELDS = {
  [BACKEND_TASK_MODEL_SUFFIX]: "model",
  [BACKEND_TASK_THINKING_SUFFIX]: "thinkingLevel",
  [BACKEND_TASK_AGENT_SUFFIX]: "agent",
};
const TASK_CREATE_FIELDS = new Set([
  "projectId", "prompt", "model", "thinkingLevel", "images", "files", "agent",
  "accountId", "accountIdExplicit", "goalLoop",
]);

/** Reads a JSON body with a hard limit. Returns `{ ok: false }` for too large, empty or broken JSON. */
function readJsonBody(request, limit = BACKEND_PROMPT_BODY_LIMIT_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve({ ok: false, reason: "too-large" });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size === 0) {
        resolve({ ok: false, reason: "empty" });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ ok: false, reason: "invalid" });
      }
    });
    request.on("error", () => resolve({ ok: false, reason: "invalid" }));
  });
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
    ...headers,
  });
  response.end(JSON.stringify(value));
}

/**
 * Creates transport only: a listening socket must not imply SDK readiness.
 * The runtime owner will supply isReady after startup reconciliation completes.
 */
export function createBackendServer({
  token,
  isReady = () => false,
  // The runtime owner supplies the store; without one the read is empty, not an error.
  readPendingSnapshots = () => [],
  /** The owner's attention list: tasks waiting on an approval or a question. Empty when detached. */
  readAttention = () => [],
  /**
   * The Backend's own view of the task store. These are stored rows, not the Web's derived
   * summaries: the derived fields stay in the Web until the relay is enabled.
   */
  readTasks = () => [],
  readTask = () => null,
  createTask = null,
  /**
   * Task detail needs the Pi runtime, so it is only supplied once one is attached. Without it the
   * route answers 503 with a specific code instead of pretending the task is missing.
   */
  readTaskDetail,
  /** The Backend's own view of the Bot store (the same files the Web app writes). */
  readBots = () => [],
  readBot = () => null,
  /** The generation (build id) of the attached runtime, or null when nothing is attached. */
  runtimeGeneration = () => null,
  /** The generation the Host pinned for this Backend, or null when it pinned none. */
  runtimeGenerationPinned = () => null,
  /**
   * The startup steps this build cannot run yet. Non-empty means the Backend is not a complete
   * replacement, so health reports why instead of only that it is not ready.
   */
  runtimeStartupIncomplete = () => [],
  /** Starts a session for a forwarded prompt; null when no runtime is attached. */
  promptTask = null,
  /** Owner-scoped active Goal Loops. A missing runtime must never report an empty list. */
  readRuntimeState = null,
  runtimeControlAction = null,
  subscribeRuntimeEvents = null,
  /** Answers a pending approval: `(id, requestId, approved) => boolean`. */
  respondToPermission = null,
  /** Answers a pending question: `(id, requestId, answer) => boolean`. */
  respondToQuestion = null,
  /** Stops a running session: `(id, botId) => task | null`; null means there was nothing to stop. */
  abortTask = null,
  /** Stops a Bot Code request (and updates the outbox): `(botId, action, body) => result`. */
  botCodeRequestAction = null,
  /** Goal Loop: start returns `{loop, agent, autoDecision?}`; controls return `loop | null`. */
  goalLoopAction = null,
  /** Starts a Bot Code session: `(botId, input) => task`; only the runtime owner may create one. */
  createBotCodeSession = null,
  /** Runs a Bot routine: `(botId, routineId) => routine`; a run prompts a session, so owner-only. */
  runBotRoutine = null,
  /** Rewinds a Bot conversation: `(botId, entryId) => result`; the owner rewrites the session. */
  revertBotTask = null,
  /** Rewinds a Room conversation: `(roomId, messageId) => result`; the owner stops its turns. */
  revertRoom = null,
  /** Posts a Room turn: `(roomId, body) => { status, body }`; the owner runs the routing ladder. */
  roomPrompt = null,
  /** Changes Room settings: `(roomId, body) => { status, body }`; the teardown is owner work. */
  roomAdminPatch = null,
  /** Deletes a Room: `(roomId) => { status, body }`; the teardown is owner work. */
  roomAdminDelete = null,
  /** Rewinds a task's session tree: `(id, entryId) => result`; only the owner edits the session. */
  revertTaskAction = null,
  /** Restores the leaf after a rewind: `(id) => task`; only the owner edits the session. */
  unrevertTaskAction = null,
  /** Archives or deletes a task: `(id, "archive" | "destroy") => result`; the owner stops its session first. */
  teardownTaskAction = null,
  /** Moves a task or hands it to / back from a Bot: `(id, request) => { status, body }`; the owner holds the session. */
  taskAdminAction = null,
  /** Archives, deletes or moves a project: `(id, action, destinationPath?) => { status, body }`; the owner stops its sessions. */
  teardownProjectAction = null,
  /** Changes or deletes a Bot: `(id, "patch" | "delete", body?) => { status, body }`; the owner holds its sessions. */
  botAdminAction = null,
  /** Rebuilds live sessions after a settings change: `({ action, agentName? }) => result`; the owner holds them. */
  reloadLiveSessionsAction = null,
  /** Backend-owned MCP dry-run; no request arguments or configuration writes. */
  readMcpMigrationDiagnostics = null,
  /** Changes a global MCP ON/OFF flag and schedules the owner's context reload. */
  setMcpServerEnabledAction = null,
  /** Adds a validated known MCP preset and reloads the owner's sessions. */
  createMcpPresetAction = null,
  /** Reads auth metadata/status in the owning process; never accepts credential inputs. */
  readMcpAuthStatus = null,
  /** Saves a validated bearer token through the owner's credential-store bridge. */
  saveMcpBearerAuthAction = null,
  /** Saves validated private headers through the owner's credential-store bridge. */
  saveMcpHeadersAuthAction = null,
  /** Removes bearer/headers/OAuth credentials; defaults are resolved only by the owner. */
  removeMcpAuthAction = null,
  /** Compacts a session: `(id, customInstructions?) => task`; the summarization runs in the owner. */
  compactTaskAction = null,
  /** Stops a running compaction: `(id) => task`; only the owner can interrupt its own session. */
  abortCompactTaskAction = null,
  /** Live session settings: `(id, value) => task`; the owner tells a running session and the store. */
  setTaskModelAction = null,
  setTaskThinkingLevelAction = null,
  setTaskAgentAction = null,
} = {}) {
  if (
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 512 ||
    /[^\x21-\x7e]/.test(token)
  ) {
    throw new Error("Backend token must contain 32-512 printable ASCII characters without spaces");
  }
  if (typeof isReady !== "function") throw new Error("isReady must be a function");
  if (typeof readPendingSnapshots !== "function") throw new Error("readPendingSnapshots must be a function");
  if (typeof readAttention !== "function") throw new Error("readAttention must be a function");
  if (typeof readTasks !== "function") throw new Error("readTasks must be a function");
  if (typeof readTask !== "function") throw new Error("readTask must be a function");
  if (readTaskDetail !== undefined && typeof readTaskDetail !== "function") {
    throw new Error("readTaskDetail must be a function");
  }
  if (typeof readBots !== "function") throw new Error("readBots must be a function");
  if (typeof readBot !== "function") throw new Error("readBot must be a function");
  if (typeof runtimeGeneration !== "function") throw new Error("runtimeGeneration must be a function");
  if (typeof runtimeGenerationPinned !== "function") {
    throw new Error("runtimeGenerationPinned must be a function");
  }
  if (typeof runtimeStartupIncomplete !== "function") {
    throw new Error("runtimeStartupIncomplete must be a function");
  }
  if (promptTask !== null && typeof promptTask !== "function") {
    throw new Error("promptTask must be a function or null");
  }
  for (const [name, handler] of Object.entries({
    respondToPermission,
    readRuntimeState,
    runtimeControlAction,
    subscribeRuntimeEvents,
    createTask,
    respondToQuestion,
    abortTask,
    botCodeRequestAction,
    goalLoopAction,
    createBotCodeSession,
    runBotRoutine,
    revertBotTask,
    revertRoom,
    roomPrompt,
    roomAdminPatch,
    roomAdminDelete,
    revertTaskAction,
    unrevertTaskAction,
    teardownTaskAction,
    taskAdminAction,
    teardownProjectAction,
    botAdminAction,
    reloadLiveSessionsAction,
    readMcpMigrationDiagnostics,
    setMcpServerEnabledAction,
    createMcpPresetAction,
    readMcpAuthStatus,
    saveMcpBearerAuthAction,
    saveMcpHeadersAuthAction,
    removeMcpAuthAction,
    compactTaskAction,
    abortCompactTaskAction,
    setTaskModelAction,
    setTaskThinkingLevelAction,
    setTaskAgentAction,
  })) {
    if (handler !== null && typeof handler !== "function") {
      throw new Error(`${name} must be a function or null`);
    }
  }
  const expectedDigest = tokenDigest(token);
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();

  // Async so the runtime-backed reads can await; every await is inside a try/catch.
  return createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (request, response) => {
    const authorization = request.headers.authorization;
    const candidate = typeof authorization === "string" && /^Bearer /i.test(authorization)
      ? authorization.slice(7)
      : "";
    if (!candidate || !timingSafeEqual(expectedDigest, tokenDigest(candidate))) {
      sendJson(response, 401, { error: "Unauthorized", code: BACKEND_ERROR_CODES.unauthorized });
      return;
    }
    if (request.headers[BACKEND_PROTOCOL_HEADER] !== String(BACKEND_PROTOCOL_VERSION)) {
      sendJson(response, 409, {
        error: "Incompatible backend protocol",
        code: BACKEND_ERROR_CODES.incompatible,
        protocolVersion: BACKEND_PROTOCOL_VERSION,
      });
      return;
    }
    // Match the request target, not the untrusted Host header. No CORS is enabled.
    const target = new URL(request.url ?? "/", "http://backend.internal");
    const taskSuffix = target.pathname.startsWith(`${BACKEND_TASKS_PATH}/`)
      ? target.pathname.slice(BACKEND_TASKS_PATH.length + 1)
      : null;
    // `<id>/detail` reads the task's detail; a bare `<id>` reads the stored row.
    const detailPath = taskSuffix?.endsWith(BACKEND_TASK_DETAIL_SUFFIX)
      ? decodeURIComponent(taskSuffix.slice(0, -BACKEND_TASK_DETAIL_SUFFIX.length))
      : undefined;
    // These suffixes act on the owning process's runtime: starting a session, or answering a pending
    // approval or question. Only the owner may serve them, so the WebUI forwards the request here.
    // `/compact/abort` is listed before `/abort`: both end with it, and the longer one owns the path.
    const actionSuffix = [
      BACKEND_TASK_COMPACT_ABORT_SUFFIX,
      BACKEND_TASK_COMPACT_SUFFIX,
      BACKEND_TASK_MODEL_SUFFIX,
      BACKEND_TASK_THINKING_SUFFIX,
      BACKEND_TASK_AGENT_SUFFIX,
      BACKEND_TASK_PROMPT_SUFFIX,
      BACKEND_TASK_PERMISSION_SUFFIX,
      BACKEND_TASK_QUESTION_SUFFIX,
      BACKEND_TASK_ABORT_SUFFIX,
      BACKEND_TASK_GOAL_LOOP_SUFFIX,
      BACKEND_TASK_REVERT_SUFFIX,
      BACKEND_TASK_UNREVERT_SUFFIX,
      BACKEND_TASK_TEARDOWN_SUFFIX,
      BACKEND_TASK_ADMIN_SUFFIX,
    ].find((suffix) => taskSuffix?.endsWith(suffix));
    const actionPath = actionSuffix === undefined || !taskSuffix
      ? undefined
      : decodeURIComponent(taskSuffix.slice(0, -actionSuffix.length));
    const taskPath = target.pathname === BACKEND_TASKS_PATH
      ? null
      : taskSuffix !== null && detailPath === undefined && actionPath === undefined
        ? decodeURIComponent(taskSuffix)
        : undefined;
    const botSuffix = target.pathname.startsWith(`${BACKEND_BOTS_PATH}/`)
      ? decodeURIComponent(target.pathname.slice(BACKEND_BOTS_PATH.length + 1))
      : undefined;
    // `<botId>/admin` changes or deletes a Bot together with the sessions it owns.
    const botAdminPath = botSuffix?.endsWith(BACKEND_BOT_ADMIN_SUFFIX)
      ? botSuffix.slice(0, -BACKEND_BOT_ADMIN_SUFFIX.length)
      : undefined;
    // `<botId>/code-requests` acts on the Bot's outbox: only the owner may write it.
    const botActionSuffix = [BACKEND_BOT_CODE_REQUESTS_SUFFIX, BACKEND_BOT_CODE_SESSIONS_SUFFIX, BACKEND_BOT_REVERT_SUFFIX]
      .find((suffix) => botSuffix?.endsWith(suffix));
    const botActionPath = botActionSuffix === undefined || !botSuffix
      ? undefined
      : decodeURIComponent(botSuffix.slice(0, -botActionSuffix.length));
    // `<botId>/routines/<routineId>` runs a routine in the owning process, which prompts a session.
    // Segments are decoded one by one: an id containing a slash must not turn into a path.
    const routineMatch = target.pathname.startsWith(`${BACKEND_BOTS_PATH}/`)
      ? target.pathname.slice(BACKEND_BOTS_PATH.length + 1).split("/")
      : null;
    const routineTarget = routineMatch?.length === 3 && routineMatch[1] === BACKEND_BOT_ROUTINES_SEGMENT
      ? { botId: decodeURIComponent(routineMatch[0]), routineId: decodeURIComponent(routineMatch[2]) }
      : undefined;
    // `/internal/rooms/<roomId>/revert` rewinds a Room conversation, and `/prompt` posts a turn:
    // both run in the owning process.
    const roomSuffix = target.pathname.startsWith(`${BACKEND_ROOMS_PATH}/`)
      ? target.pathname.slice(BACKEND_ROOMS_PATH.length + 1)
      : null;
    const roomActionSuffix = [BACKEND_ROOM_REVERT_SUFFIX, BACKEND_ROOM_PROMPT_SUFFIX]
      .find((suffix) => roomSuffix?.endsWith(suffix));
    const roomActionPath = roomActionSuffix === undefined || !roomSuffix
      ? undefined
      : decodeURIComponent(roomSuffix.slice(0, -roomActionSuffix.length));
    // A bare `/internal/rooms/<roomId>` is the Room itself: PATCH changes it, DELETE removes it.
    const roomPath = roomSuffix !== null && roomActionPath === undefined && !roomSuffix.includes("/")
      ? decodeURIComponent(roomSuffix)
      : undefined;
    // `/internal/projects/<id>/teardown` archives, deletes or moves a project and its sessions.
    const projectSuffix = target.pathname.startsWith(`${BACKEND_PROJECTS_PATH}/`)
      ? target.pathname.slice(BACKEND_PROJECTS_PATH.length + 1)
      : null;
    const projectActionPath = projectSuffix?.endsWith(BACKEND_PROJECT_TEARDOWN_SUFFIX)
      ? decodeURIComponent(projectSuffix.slice(0, -BACKEND_PROJECT_TEARDOWN_SUFFIX.length))
      : undefined;
    const knownPath = target.pathname === BACKEND_HEALTH_PATH
      || target.pathname === BACKEND_RUNTIME_CONTROL_PATH
      || target.pathname === BACKEND_RUNTIME_EVENTS_PATH
      || target.pathname === BACKEND_LIVE_SESSIONS_RELOAD_PATH
      || target.pathname === BACKEND_MCP_MIGRATION_PATH
      || target.pathname.startsWith(`${BACKEND_MCP_SERVERS_PATH}/`)
      || target.pathname === BACKEND_MCP_SERVERS_PATH
      || projectActionPath !== undefined
      || botAdminPath !== undefined
      || target.pathname === BACKEND_PENDING_SNAPSHOTS_PATH
      || target.pathname === BACKEND_ATTENTION_PATH
      || target.pathname === BACKEND_TASKS_PATH
      || target.pathname === BACKEND_BOTS_PATH
      || botSuffix !== undefined
      || botActionPath !== undefined
      || routineTarget !== undefined
      || roomActionPath !== undefined
      || roomPath !== undefined
      || taskPath !== undefined
      || detailPath !== undefined
      || actionPath !== undefined;
    if (!knownPath) {
      sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
      return;
    }
    if (target.pathname.startsWith(`${BACKEND_MCP_SERVERS_PATH}/`) && target.pathname.endsWith(BACKEND_MCP_AUTH_SUFFIX)) {
      if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
        sendJson(response, 405, { error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed }, { Allow: "GET, POST, DELETE" });
        return;
      }
      let name;
      try { name = decodeURIComponent(target.pathname.slice(BACKEND_MCP_SERVERS_PATH.length + 1, -BACKEND_MCP_AUTH_SUFFIX.length)).trim(); }
      catch { sendJson(response, 400, { error: "Invalid MCP server name", code: BACKEND_ERROR_CODES.badRequest }); return; }
      if (!name || name.includes("/") || name.includes("\\") || name.includes("..") || target.search) {
        sendJson(response, 400, { error: "Invalid MCP auth status request", code: BACKEND_ERROR_CODES.badRequest });
        return;
      }
      let ready = false;
      try { ready = isReady() === true; } catch { /* Refuse without exception detail. */ }
      const available = request.method === "DELETE" ? removeMcpAuthAction
        : request.method === "POST" ? saveMcpBearerAuthAction || saveMcpHeadersAuthAction : readMcpAuthStatus;
      if (!available || !ready) {
        sendJson(response, 503, { error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable });
        return;
      }
      if (request.method === "DELETE") {
        const body = await readJsonBody(request, 4096);
        const parsed = body.ok ? parseMcpAuthRemoveRequest(body.value)
          : body.reason === "empty" ? parseMcpAuthRemoveRequest({}) : { ok: false };
        if (!parsed.ok) {
          sendJson(response, 400, { error: "Invalid MCP auth removal request", code: BACKEND_ERROR_CODES.badRequest });
          return;
        }
        try {
          const result = publicMcpAuthRemoveResult(await removeMcpAuthAction(name, parsed.value));
          if (!result || result.auth.name !== name) throw new Error("Invalid MCP auth removal result");
          sendJson(response, 200, result);
        } catch (error) {
          const status = [400, 404, 409, 503].includes(error?.status) ? error.status : 500;
          sendJson(response, status, { error: "Backend MCP auth removal failed",
            code: status === 404 ? BACKEND_ERROR_CODES.notFound : status < 500 ? BACKEND_ERROR_CODES.badRequest : BACKEND_ERROR_CODES.internal });
        }
        return;
      }
      if (request.method === "POST") {
        // 32 headers at 8192 UTF-16 characters each, including JSON escape expansion.
        const body = await readJsonBody(request, 2_097_152);
        const isHeaders = (body.value?.type ?? body.value?.action) === "headers";
        const parsed = body.ok ? (isHeaders ? parseMcpHeadersSaveRequest(body.value) : parseMcpBearerSaveRequest(body.value)) : { ok: false };
        if (!parsed.ok) {
          sendJson(response, 400, { error: "Invalid MCP auth save request", code: BACKEND_ERROR_CODES.badRequest });
          return;
        }
        const action = isHeaders ? saveMcpHeadersAuthAction : saveMcpBearerAuthAction;
        if (!action) {
          sendJson(response, 503, { error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable });
          return;
        }
        try {
          const value = await action(name, parsed.value);
          const result = isHeaders ? publicMcpHeadersSaveResult(value) : publicMcpBearerSaveResult(value);
          if (!result || result.auth.name !== name) throw new Error("Invalid MCP auth save result");
          sendJson(response, 200, result);
        } catch (error) {
          const status = [400, 404, 409, 503].includes(error?.status) ? error.status : 500;
          sendJson(response, status, { error: "Backend MCP auth save failed",
            code: status === 404 ? BACKEND_ERROR_CODES.notFound : status < 500 ? BACKEND_ERROR_CODES.badRequest : BACKEND_ERROR_CODES.internal });
        }
        return;
      }
      try {
        const snapshot = publicMcpAuthSnapshot(await readMcpAuthStatus(name));
        if (!snapshot || snapshot.name !== name) throw new Error("Invalid MCP auth metadata");
        sendJson(response, 200, snapshot);
      } catch (error) {
        const status = [400, 404, 503].includes(error?.status) ? error.status : 500;
        sendJson(response, status, { error: "Backend MCP auth status failed",
          code: status === 404 ? BACKEND_ERROR_CODES.notFound : status < 500 ? BACKEND_ERROR_CODES.badRequest : BACKEND_ERROR_CODES.internal });
      }
      return;
    }
    if (target.pathname === BACKEND_MCP_SERVERS_PATH) {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed }, { Allow: "POST" });
        return;
      }
      if (target.search) {
        sendJson(response, 400, { error: "Invalid MCP preset request", code: BACKEND_ERROR_CODES.badRequest });
        return;
      }
      let ready = false;
      try { ready = isReady() === true; } catch { /* Refuse without exception detail. */ }
      if (!createMcpPresetAction || !ready) {
        sendJson(response, 503, { error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable });
        return;
      }
      const body = await readJsonBody(request, 16_384);
      const parsed = body.ok ? parseMcpPresetRequest(body.value) : { ok: false };
      if (!parsed.ok) {
        sendJson(response, 400, { error: "Invalid MCP preset request", code: BACKEND_ERROR_CODES.badRequest });
        return;
      }
      try { sendJson(response, 200, await createMcpPresetAction(parsed.value)); }
      catch (error) {
        const status = [400, 404, 409, 503].includes(error?.status) ? error.status : 500;
        sendJson(response, status, { error: "Backend MCP preset creation failed",
          code: status === 404 ? BACKEND_ERROR_CODES.notFound : status < 500 ? BACKEND_ERROR_CODES.badRequest : BACKEND_ERROR_CODES.internal });
      }
      return;
    }
    if (target.pathname.startsWith(`${BACKEND_MCP_SERVERS_PATH}/`)) {
      if (request.method !== "PATCH") {
        sendJson(response, 405, { error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed }, { Allow: "PATCH" });
        return;
      }
      let name;
      try { name = decodeURIComponent(target.pathname.slice(BACKEND_MCP_SERVERS_PATH.length + 1)).trim(); }
      catch { sendJson(response, 400, { error: "Invalid MCP server name", code: BACKEND_ERROR_CODES.badRequest }); return; }
      if (!name || name.includes("/") || name.includes("\\") || name.includes("..") || target.search) {
        sendJson(response, 400, { error: "Invalid MCP setting request", code: BACKEND_ERROR_CODES.badRequest });
        return;
      }
      let ready = false;
      try { ready = isReady() === true; } catch { /* Refuse without exception detail. */ }
      if (!setMcpServerEnabledAction || !ready) {
        sendJson(response, 503, { error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable });
        return;
      }
      const body = await readJsonBody(request, 4096);
      if (!body.ok || !body.value || typeof body.value !== "object" || Array.isArray(body.value)
        || typeof body.value.enabled !== "boolean" || Object.keys(body.value).some((key) => key !== "enabled")) {
        sendJson(response, 400, { error: "Invalid MCP setting request", code: BACKEND_ERROR_CODES.badRequest });
        return;
      }
      try { sendJson(response, 200, await setMcpServerEnabledAction(name, body.value.enabled)); }
      catch (error) {
        const status = [400, 404, 409, 503].includes(error?.status) ? error.status : 500;
        sendJson(response, status, { error: "Backend MCP setting update failed",
          code: status === 404 ? BACKEND_ERROR_CODES.notFound : status < 500 ? BACKEND_ERROR_CODES.badRequest : BACKEND_ERROR_CODES.internal });
      }
      return;
    }
    if (target.pathname === BACKEND_MCP_MIGRATION_PATH) {
      if (request.method !== "GET") {
        sendJson(response, 405, {
          error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed,
        }, { Allow: "GET" });
        return;
      }
      if (target.search) {
        sendJson(response, 400, { error: "Migration diagnostics take no parameters", code: BACKEND_ERROR_CODES.badRequest });
        return;
      }
      if (!readMcpMigrationDiagnostics) {
        sendJson(response, 503, { error: "Backend migration diagnostics unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable });
        return;
      }
      try { sendJson(response, 200, { result: await readMcpMigrationDiagnostics() }); }
      catch { sendJson(response, 500, { error: "Backend migration diagnostics failed", code: BACKEND_ERROR_CODES.internal }); }
      return;
    }
    if (target.pathname === BACKEND_RUNTIME_EVENTS_PATH && request.method === "GET") {
      if (!subscribeRuntimeEvents || !isReady()) {
        sendJson(response, 503, { error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable });
        return;
      }
      streamRuntimeEvents(response, subscribeRuntimeEvents);
      return;
    }
    if (target.pathname === BACKEND_RUNTIME_CONTROL_PATH && request.method === "POST") {
      if (!runtimeControlAction) {
        sendJson(response, 503, { error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable });
        return;
      }
      const body = await readJsonBody(request, 4096);
      const value = body.value;
      const actions = new Set(["read-compaction", "set-compaction", "read-cache-warming", "set-cache-warming", "refresh-compaction", "code-permissions"]);
      if (!body.ok || !value || typeof value !== "object" || Array.isArray(value) || !actions.has(value.action)
        || Object.keys(value).some((key) => key !== "action" && key !== "value")
        || (value.action === "set-compaction" && typeof value.value !== "boolean")
        || (value.action === "set-cache-warming" && !["off", "streaming", "idle"].includes(value.value))) {
        sendJson(response, 400, { error: "Invalid runtime setting", code: BACKEND_ERROR_CODES.badRequest });
        return;
      }
      try { sendJson(response, 200, { result: await runtimeControlAction(value) }); }
      catch { sendJson(response, 503, { error: "Backend setting update failed", code: BACKEND_ERROR_CODES.runtimeUnavailable }); }
      return;
    }
    if (target.pathname === BACKEND_RUNTIME_CONTROL_PATH && request.method === "GET") {
      if (!readRuntimeState) {
        sendJson(response, 503, { error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable });
        return;
      }
      try { sendJson(response, 200, await readRuntimeState()); }
      catch { sendJson(response, 503, { error: "Backend runtime state unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable }); }
      return;
    }
    if (target.pathname === BACKEND_TASKS_PATH && request.method === "POST") {
      if (!createTask) {
        sendJson(response, 503, { error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable });
        return;
      }
      const body = await readJsonBody(request);
      if (!body.ok || !body.value || typeof body.value !== "object" || Array.isArray(body.value)
        || (body.value.projectId !== null && typeof body.value.projectId !== "string")
        || typeof body.value.prompt !== "string"
        || (!body.value.prompt.trim() && !body.value.images?.length && !body.value.files?.length)
        || Object.keys(body.value).some((key) => !TASK_CREATE_FIELDS.has(key))
        || (body.value.model !== undefined && typeof body.value.model !== "string")
        || (body.value.agent !== undefined && typeof body.value.agent !== "string")
        || (body.value.accountId !== undefined && typeof body.value.accountId !== "string")
        || (body.value.accountIdExplicit !== undefined && typeof body.value.accountIdExplicit !== "boolean")) {
        sendJson(response, !body.ok && body.reason === "too-large" ? 413 : 400,
          { error: "Invalid task create request", code: BACKEND_ERROR_CODES.badRequest });
        return;
      }
      try {
        sendJson(response, 200, { task: await createTask(body.value) });
      } catch (error) {
        sendJson(response, typeof error?.status === "number" ? error.status : 500,
          { error: "Backend task create failed", code: BACKEND_ERROR_CODES.internal });
      }
      return;
    }
    if (actionPath !== undefined) {
      if (request.method !== "POST") {
        sendJson(response, 405, {
          error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed,
        }, { Allow: "POST" });
        return;
      }
      if (actionPath === "") {
        sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
        return;
      }
      // No runtime means this process cannot own a session: the caller must not fall back locally.
      const handlers = {
        [BACKEND_TASK_PROMPT_SUFFIX]: promptTask,
        [BACKEND_TASK_PERMISSION_SUFFIX]: respondToPermission,
        [BACKEND_TASK_QUESTION_SUFFIX]: respondToQuestion,
        [BACKEND_TASK_ABORT_SUFFIX]: abortTask,
        [BACKEND_TASK_GOAL_LOOP_SUFFIX]: goalLoopAction,
        [BACKEND_TASK_REVERT_SUFFIX]: revertTaskAction,
        [BACKEND_TASK_UNREVERT_SUFFIX]: unrevertTaskAction,
        [BACKEND_TASK_TEARDOWN_SUFFIX]: teardownTaskAction,
        [BACKEND_TASK_ADMIN_SUFFIX]: taskAdminAction,
        [BACKEND_TASK_COMPACT_SUFFIX]: compactTaskAction,
        [BACKEND_TASK_COMPACT_ABORT_SUFFIX]: abortCompactTaskAction,
        [BACKEND_TASK_MODEL_SUFFIX]: setTaskModelAction,
        [BACKEND_TASK_THINKING_SUFFIX]: setTaskThinkingLevelAction,
        [BACKEND_TASK_AGENT_SUFFIX]: setTaskAgentAction,
      };
      const handler = actionSuffix ? handlers[actionSuffix] : undefined;
      if (typeof handler !== "function") {
        sendJson(response, 503, {
          error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable,
        });
        return;
      }
      // Abort, unrevert and a compaction abort take no input, so an empty body is normal there.
      const body = actionSuffix === BACKEND_TASK_ABORT_SUFFIX || actionSuffix === BACKEND_TASK_UNREVERT_SUFFIX
        || actionSuffix === BACKEND_TASK_COMPACT_ABORT_SUFFIX
        ? await readJsonBody(request).then((read) => (read.ok ? read : { ok: true, value: {} }))
        : await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.reason === "too-large" ? 413 : 400, {
          error: body.reason === "too-large" ? "Request body too large" : "Invalid request body",
          code: BACKEND_ERROR_CODES.badRequest,
        });
        return;
      }
      try {
        if (actionSuffix === BACKEND_TASK_GOAL_LOOP_SUFFIX) {
          const action = body.value?.action;
          if (
            action !== "start" && action !== "pause" && action !== "resume" && action !== "stop" && action !== "complete"
          ) {
            sendJson(response, 400, { error: "Invalid goal loop action", code: BACKEND_ERROR_CODES.badRequest });
            return;
          }
          if (action === "start" && body.value?.botId !== undefined && (
            typeof body.value.botId !== "string" || !body.value.botId || actionPath !== `bot:${body.value.botId}`
          )) {
            sendJson(response, 400, { error: "Bot task mismatch", code: BACKEND_ERROR_CODES.badRequest });
            return;
          }
          const result = await handler(actionPath, body.value);
          const loop = action === "start" ? result?.loop : result;
          if (!loop) {
            sendJson(response, 404, { error: "Goal loop not found", code: BACKEND_ERROR_CODES.notFound });
            return;
          }
          sendJson(response, 200, action === "start"
            ? { loop, agent: result.agent ?? null, ...(result.autoDecision ? { autoDecision: result.autoDecision } : {}) }
            : { loop });
        } else if (SETTING_FIELDS[actionSuffix] !== undefined) {
          // Each route's own validation is kept: a model must be non-empty, a thinking level truthy,
          // and an empty agent is meaningful (it clears the agent).
          const field = SETTING_FIELDS[actionSuffix];
          const value = body.value?.[field];
          const valid = field === "agent" ? typeof value === "string" : typeof value === "string" && value.trim() !== "";
          if (!valid) {
            sendJson(response, 400, { error: `Invalid ${field}`, code: BACKEND_ERROR_CODES.badRequest });
            return;
          }
          const task = await handler(actionPath, value);
          if (!task) {
            sendJson(response, 404, { error: "Task not found", code: BACKEND_ERROR_CODES.notFound });
            return;
          }
          sendJson(response, 200, { task });
        } else if (actionSuffix === BACKEND_TASK_COMPACT_SUFFIX) {
          const customInstructions = typeof body.value?.customInstructions === "string" ? body.value.customInstructions : undefined;
          const task = await handler(actionPath, customInstructions);
          if (!task) {
            sendJson(response, 404, { error: "Task not found", code: BACKEND_ERROR_CODES.notFound });
            return;
          }
          sendJson(response, 200, { task });
        } else if (actionSuffix === BACKEND_TASK_COMPACT_ABORT_SUFFIX) {
          const task = await handler(actionPath);
          if (!task) {
            sendJson(response, 404, { error: "Task not found", code: BACKEND_ERROR_CODES.notFound });
            return;
          }
          sendJson(response, 200, { task });
        } else if (actionSuffix === BACKEND_TASK_REVERT_SUFFIX) {
          const entryId = typeof body.value?.entryId === "string" ? body.value.entryId.trim() : "";
          if (!entryId) {
            sendJson(response, 400, { error: "Invalid revert request", code: BACKEND_ERROR_CODES.badRequest });
            return;
          }
          sendJson(response, 200, await handler(actionPath, entryId));
        } else if (actionSuffix === BACKEND_TASK_UNREVERT_SUFFIX) {
          const task = await handler(actionPath);
          if (!task) {
            sendJson(response, 404, { error: "Task not found", code: BACKEND_ERROR_CODES.notFound });
            return;
          }
          sendJson(response, 200, { task });
        } else if (actionSuffix === BACKEND_TASK_ADMIN_SUFFIX) {
          const { action, destinationPath, botId } = body.value ?? {};
          const valid = (action === "promote" && typeof destinationPath === "string" && destinationPath.trim())
            || (action === "handoff" && typeof botId === "string" && botId.trim())
            || action === "release";
          if (!valid) {
            sendJson(response, 400, { error: "Invalid task admin request", code: BACKEND_ERROR_CODES.badRequest });
            return;
          }
          sendJson(response, 200, { result: await handler(actionPath, { action, destinationPath, botId }) });
        } else if (actionSuffix === BACKEND_TASK_TEARDOWN_SUFFIX) {
          const mode = body.value?.mode;
          if (mode !== "archive" && mode !== "destroy") {
            sendJson(response, 400, { error: "Invalid teardown request", code: BACKEND_ERROR_CODES.badRequest });
            return;
          }
          sendJson(response, 200, { result: await handler(actionPath, mode) });
        } else if (actionSuffix === BACKEND_TASK_ABORT_SUFFIX) {
          const botId = typeof body.value?.botId === "string" && body.value.botId ? body.value.botId : null;
          const task = await handler(actionPath, botId);
          if (!task) {
            sendJson(response, 404, { error: "Task not found", code: BACKEND_ERROR_CODES.notFound });
            return;
          }
          sendJson(response, 200, { task });
        } else if (actionSuffix === BACKEND_TASK_PROMPT_SUFFIX) {
          const summary = await handler(actionPath, body.value);
          // Owning-mode selection/recovery carries its original HTTP contract inside the envelope.
          if (Number.isInteger(summary?.status) && summary.body && typeof summary.body === "object") {
            sendJson(response, 200, { result: summary });
          } else sendJson(response, 200, { task: summary ?? null });
        } else if (actionSuffix === BACKEND_TASK_PERMISSION_SUFFIX) {
          const { requestId, approved } = body.value ?? {};
          if (typeof requestId !== "string" || typeof approved !== "boolean") {
            sendJson(response, 400, { error: "Invalid permission answer", code: BACKEND_ERROR_CODES.badRequest });
            return;
          }
          const ok = await handler(actionPath, requestId, approved);
          sendJson(response, ok ? 200 : 404, ok
            ? { ok: true }
            : { error: "Permission request not found", code: BACKEND_ERROR_CODES.notFound });
        } else {
          const { requestId, answer } = body.value ?? {};
          if (typeof requestId !== "string") {
            sendJson(response, 400, { error: "Invalid question answer", code: BACKEND_ERROR_CODES.badRequest });
            return;
          }
          const ok = await handler(actionPath, requestId, answer ?? null);
          sendJson(response, ok ? 200 : 404, ok
            ? { ok: true }
            : { error: "Question request not found", code: BACKEND_ERROR_CODES.notFound });
        }
      } catch (error) {
        // Status-tagged Japanese messages are intentional UI copy; English/provider text stays opaque.
        const facing = clientFacingActionError(error, "Backend task action failed");
        sendJson(response, facing.status, facing.body);
      }
      return;
    }
    if (roomPath !== undefined) {
      const isPatch = request.method === "PATCH";
      const isDelete = request.method === "DELETE";
      if (!isPatch && !isDelete) {
        sendJson(response, 405, {
          error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed,
        }, { Allow: "PATCH, DELETE" });
        return;
      }
      const handler = isPatch ? roomAdminPatch : roomAdminDelete;
      if (typeof handler !== "function") {
        sendJson(response, 503, {
          error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable,
        });
        return;
      }
      let body = { ok: true, value: null };
      if (isPatch) {
        body = await readJsonBody(request);
        if (!body.ok) {
          sendJson(response, body.reason === "too-large" ? 413 : 400, {
            error: body.reason === "too-large" ? "Request body too large" : "Invalid request body",
            code: BACKEND_ERROR_CODES.badRequest,
          });
          return;
        }
      }
      try {
        // The owner's answer carries its own status and body; the WebUI replays them unchanged.
        const result = isPatch ? await handler(roomPath, body.value ?? null) : await handler(roomPath);
        const status = Number.isInteger(result?.status) ? result.status : 200;
        sendJson(response, 200, { result: { status, body: result?.body ?? null } });
      } catch (error) {
        sendJson(response, typeof error?.status === "number" ? error.status : 500, {
          error: "Backend room admin failed",
          code: BACKEND_ERROR_CODES.internal,
        });
      }
      return;
    }
    if (target.pathname === BACKEND_LIVE_SESSIONS_RELOAD_PATH) {
      if (request.method !== "POST") {
        sendJson(response, 405, {
          error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed,
        }, { Allow: "POST" });
        return;
      }
      if (typeof reloadLiveSessionsAction !== "function") {
        sendJson(response, 503, {
          error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable,
        });
        return;
      }
      const body = await readJsonBody(request);
      const action = body.ok ? body.value?.action : undefined;
      const agentName = body.ok ? body.value?.agentName : undefined;
      if (!body.ok || (action !== "reload" && !(action === "refresh-agent" && typeof agentName === "string" && agentName.trim()))) {
        sendJson(response, body.ok ? 400 : body.reason === "too-large" ? 413 : 400, {
          error: "Invalid live session reload request", code: BACKEND_ERROR_CODES.badRequest,
        });
        return;
      }
      try {
        sendJson(response, 200, { result: await reloadLiveSessionsAction({ action, agentName }) });
      } catch (error) {
        sendJson(response, typeof error?.status === "number" ? error.status : 500, {
          error: "Backend live session reload failed", code: BACKEND_ERROR_CODES.internal,
        });
      }
      return;
    }
    if (projectActionPath !== undefined) {
      if (request.method !== "POST") {
        sendJson(response, 405, {
          error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed,
        }, { Allow: "POST" });
        return;
      }
      if (!projectActionPath) {
        sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
        return;
      }
      if (typeof teardownProjectAction !== "function") {
        sendJson(response, 503, {
          error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable,
        });
        return;
      }
      const body = await readJsonBody(request);
      const action = body.ok ? body.value?.action : undefined;
      const destinationPath = body.ok ? body.value?.destinationPath : undefined;
      if (!body.ok || (action !== "archive" && action !== "destroy" && action !== "migrate")
        || (action === "migrate" && (typeof destinationPath !== "string" || !destinationPath.trim()))) {
        sendJson(response, body.ok ? 400 : body.reason === "too-large" ? 413 : 400, {
          error: "Invalid project teardown request", code: BACKEND_ERROR_CODES.badRequest,
        });
        return;
      }
      try {
        sendJson(response, 200, { result: await teardownProjectAction(projectActionPath, action, destinationPath) });
      } catch (error) {
        sendJson(response, typeof error?.status === "number" ? error.status : 500, {
          error: "Backend project teardown failed", code: BACKEND_ERROR_CODES.internal,
        });
      }
      return;
    }
    if (roomActionPath !== undefined) {
      if (request.method !== "POST") {
        sendJson(response, 405, {
          error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed,
        }, { Allow: "POST" });
        return;
      }
      if (!roomActionPath) {
        sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
        return;
      }
      const handler = roomActionSuffix === BACKEND_ROOM_PROMPT_SUFFIX ? roomPrompt : revertRoom;
      if (typeof handler !== "function") {
        sendJson(response, 503, {
          error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable,
        });
        return;
      }
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.reason === "too-large" ? 413 : 400, {
          error: body.reason === "too-large" ? "Request body too large" : "Invalid request body",
          code: BACKEND_ERROR_CODES.badRequest,
        });
        return;
      }
      try {
        if (roomActionSuffix === BACKEND_ROOM_PROMPT_SUFFIX) {
          // The owner's answer carries its own status and body; the WebUI replays them unchanged.
          const result = await handler(roomActionPath, body.value ?? null);
          const status = Number.isInteger(result?.status) ? result.status : 200;
          sendJson(response, 200, { result: { status, body: result?.body ?? null } });
        } else {
          const messageId = typeof body.value?.messageId === "string" ? body.value.messageId.trim() : "";
          if (!messageId) {
            sendJson(response, 400, { error: "Invalid revert request", code: BACKEND_ERROR_CODES.badRequest });
            return;
          }
          sendJson(response, 200, await handler(roomActionPath, messageId));
        }
      } catch (error) {
        // A coded refusal (unknown room or message) keeps its status; nothing else leaks.
        sendJson(response, typeof error?.status === "number" ? error.status : 500, {
          error: "Backend room request failed",
          code: BACKEND_ERROR_CODES.internal,
        });
      }
      return;
    }
    if (routineTarget !== undefined) {
      if (request.method !== "POST") {
        sendJson(response, 405, {
          error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed,
        }, { Allow: "POST" });
        return;
      }
      if (typeof runBotRoutine !== "function") {
        sendJson(response, 503, {
          error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable,
        });
        return;
      }
      // The body is unused; draining it keeps the connection reusable instead of ending with an
      // unread request body.
      await readJsonBody(request, 64 * 1024);
      try {
        const routine = await runBotRoutine(routineTarget.botId, routineTarget.routineId);
        if (!routine) {
          sendJson(response, 404, { error: "Routine not found", code: BACKEND_ERROR_CODES.notFound });
          return;
        }
        sendJson(response, 200, { routine });
      } catch (error) {
        // A coded refusal (missing routine, concurrent run) keeps its status; nothing else leaks.
        sendJson(response, typeof error?.status === "number" ? error.status : 500, {
          error: "Backend routine run failed",
          code: BACKEND_ERROR_CODES.internal,
        });
      }
      return;
    }
    if (botAdminPath !== undefined) {
      if (request.method !== "POST") {
        sendJson(response, 405, {
          error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed,
        }, { Allow: "POST" });
        return;
      }
      if (!botAdminPath || botAdminPath.includes("/")) {
        sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
        return;
      }
      if (typeof botAdminAction !== "function") {
        sendJson(response, 503, {
          error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable,
        });
        return;
      }
      const body = await readJsonBody(request);
      const action = body.ok ? body.value?.action : undefined;
      if (!body.ok || (action !== "patch" && action !== "delete")) {
        sendJson(response, body.ok ? 400 : body.reason === "too-large" ? 413 : 400, {
          error: "Invalid bot admin request", code: BACKEND_ERROR_CODES.badRequest,
        });
        return;
      }
      try {
        sendJson(response, 200, { result: await botAdminAction(botAdminPath, action, body.value?.body ?? null) });
      } catch (error) {
        sendJson(response, typeof error?.status === "number" ? error.status : 500, {
          error: "Backend bot admin failed", code: BACKEND_ERROR_CODES.internal,
        });
      }
      return;
    }
    if (botActionPath !== undefined) {
      if (request.method !== "POST") {
        sendJson(response, 405, {
          error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed,
        }, { Allow: "POST" });
        return;
      }
      if (botActionPath === "") {
        sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
        return;
      }
      const botHandler = botActionSuffix === BACKEND_BOT_CODE_SESSIONS_SUFFIX
        ? createBotCodeSession
        : botActionSuffix === BACKEND_BOT_REVERT_SUFFIX
          ? revertBotTask
          : botCodeRequestAction;
      if (typeof botHandler !== "function") {
        sendJson(response, 503, {
          error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable,
        });
        return;
      }
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.reason === "too-large" ? 413 : 400, {
          error: body.reason === "too-large" ? "Request body too large" : "Invalid request body",
          code: BACKEND_ERROR_CODES.badRequest,
        });
        return;
      }
      try {
        if (botActionSuffix === BACKEND_BOT_REVERT_SUFFIX) {
          const entryId = typeof body.value?.entryId === "string" ? body.value.entryId.trim() : "";
          if (!entryId) {
            sendJson(response, 400, { error: "Invalid revert request", code: BACKEND_ERROR_CODES.badRequest });
            return;
          }
          sendJson(response, 200, await botHandler(botActionPath, entryId));
        } else if (botActionSuffix === BACKEND_BOT_CODE_SESSIONS_SUFFIX) {
          const task = await botHandler(botActionPath, body.value);
          sendJson(response, 200, { task: task ?? null });
        } else {
          const result = await botHandler(botActionPath, body.value);
          if (!result) {
            sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
            return;
          }
          sendJson(response, 200, result);
        }
      } catch (error) {
        sendJson(response, typeof error?.status === "number" ? error.status : 500, {
          error: "Backend bot request action failed",
          code: BACKEND_ERROR_CODES.internal,
        });
      }
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, {
        error: "Method not allowed", code: BACKEND_ERROR_CODES.methodNotAllowed,
      }, { Allow: "GET" });
      return;
    }
    if (target.pathname === BACKEND_BOTS_PATH || botSuffix !== undefined) {
      try {
        if (botSuffix !== undefined) {
          const bot = botSuffix ? readBot(botSuffix) : null;
          if (!bot) {
            sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
            return;
          }
          sendJson(response, 200, { bot });
        } else {
          sendJson(response, 200, { bots: readBots() ?? [] });
        }
      } catch {
        // Never send exception messages: a store failure must not leak paths or ids.
        sendJson(response, 500, {
          error: "Backend bot read failed", code: BACKEND_ERROR_CODES.internal,
        });
      }
      return;
    }
    if (detailPath !== undefined) {
      if (!detailPath) {
        sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
        return;
      }
      const messagesMode = target.searchParams.get("messages");
      const paged = messagesMode === "page";
      const omitMessages = messagesMode === "omit";
      const before = target.searchParams.get("before");
      if ((messagesMode !== null && ((!paged && !omitMessages) || target.searchParams.getAll("messages").length !== 1))
        || (paged && (target.searchParams.getAll("before").length > 1
          || (before !== null && (!before.trim() || before.length > 512))))
        || (omitMessages && before !== null)) {
        sendJson(response, 400, { error: "Invalid history page request", code: BACKEND_ERROR_CODES.badRequest });
        return;
      }
      if (typeof readTaskDetail !== "function") {
        sendJson(response, 503, {
          error: "Backend runtime is not attached", code: BACKEND_ERROR_CODES.runtimeUnavailable,
        });
        return;
      }
      try {
        const detail = await readTaskDetail(detailPath, { includeMessages: !omitMessages });
        if (!detail) {
          sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
          return;
        }
        sendJson(response, 200, { detail: paged
          ? { ...detail, ...pageTaskMessages(Array.isArray(detail.messages) ? detail.messages : [], before) }
          : detail });
      } catch (error) {
        if (error instanceof InvalidTaskMessageCursorError) {
          sendJson(response, 409, { error: "Invalid history cursor", code: BACKEND_ERROR_CODES.badRequest });
          return;
        }
        const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
        // A coded refusal keeps its status; anything else is an internal failure with no detail.
        if (status === 404) {
          sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
        } else if (status === 503) {
          sendJson(response, 503, {
            error: "Backend runtime is not attached", code: BACKEND_ERROR_CODES.runtimeUnavailable,
          });
        } else {
          sendJson(response, 500, {
            error: "Backend task detail read failed", code: BACKEND_ERROR_CODES.internal,
          });
        }
      }
      return;
    }
    if (taskPath !== undefined) {
      try {
        if (taskPath === null) {
          sendJson(response, 200, { tasks: readTasks() ?? [] });
          return;
        }
        const task = readTask(taskPath);
        if (!task) {
          sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
          return;
        }
        sendJson(response, 200, { task });
      } catch {
        // Never send exception messages: a store failure must not leak paths or ids.
        sendJson(response, 500, {
          error: "Backend task read failed", code: BACKEND_ERROR_CODES.internal,
        });
      }
      return;
    }
    if (target.pathname === BACKEND_ATTENTION_PATH) {
      try {
        sendJson(response, 200, { items: readAttention() ?? [] });
      } catch {
        // Never send exception messages: a store failure must not leak paths or ids.
        sendJson(response, 500, {
          error: "Backend attention read failed", code: BACKEND_ERROR_CODES.internal,
        });
      }
      return;
    }
    if (target.pathname === BACKEND_PENDING_SNAPSHOTS_PATH) {
      try {
        sendJson(response, 200, { snapshots: readPendingSnapshots() ?? [] });
      } catch {
        // Never send exception messages: a store failure must not leak paths or ids.
        sendJson(response, 500, {
          error: "Backend pending snapshot read failed", code: BACKEND_ERROR_CODES.internal,
        });
      }
      return;
    }
    try {
      const ready = isReady() === true;
      sendJson(response, ready ? 200 : 503, {
        service: "leafcode-pi-backend",
        protocolVersion: BACKEND_PROTOCOL_VERSION,
        instanceId,
        pid: process.pid,
        startedAt,
        ready,
        status: ready ? "ready" : "starting",
        // Lets the frontend detect that the running Backend is an older/newer build than itself,
        // and see which generation the Host pinned when it started this process.
        runtimeGeneration: runtimeGeneration() ?? null,
        runtimeGenerationPinned: runtimeGenerationPinned() ?? null,
        // Empty when this build can run every startup step: an operator can tell a slow start from
        // a Backend that is not a complete replacement yet.
        runtimeStartupIncomplete: runtimeStartupIncomplete() ?? [],
      });
    } catch {
      // Never send exception messages: providers may include credentials in them.
      sendJson(response, 500, {
        error: "Backend health check failed", code: BACKEND_ERROR_CODES.internal,
      });
    }
  });
}

/** Always loopback; the frontend is the sole externally accessible gateway. */
export async function listenBackend(server, port = DEFAULT_BACKEND_PORT) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid backend port");
  }
  // once(listening) rejects on error, including EADDRINUSE.
  const listening = once(server, "listening");
  server.listen(port, "127.0.0.1");
  await listening;
  return server.address();
}

export async function closeBackend(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}
