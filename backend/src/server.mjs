import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  BACKEND_ERROR_CODES,
  BACKEND_HEALTH_PATH,
  BACKEND_BOT_CODE_REQUESTS_SUFFIX,
  BACKEND_BOT_CODE_SESSIONS_SUFFIX,
  BACKEND_BOTS_PATH,
  BACKEND_PENDING_SNAPSHOTS_PATH,
  BACKEND_PROTOCOL_HEADER,
  BACKEND_PROTOCOL_VERSION,
  BACKEND_TASK_ABORT_SUFFIX,
  BACKEND_TASK_DETAIL_SUFFIX,
  BACKEND_TASK_GOAL_LOOP_SUFFIX,
  BACKEND_TASK_PERMISSION_SUFFIX,
  BACKEND_TASK_QUESTION_SUFFIX,
  BACKEND_TASK_PROMPT_SUFFIX,
  BACKEND_TASKS_PATH,
  DEFAULT_BACKEND_PORT,
} from "../../shared/backend-protocol.mjs";

function tokenDigest(value) {
  return createHash("sha256").update(value).digest();
}

/** The largest prompt body the Backend accepts; attachments are already size-checked by the WebUI. */
export const BACKEND_PROMPT_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

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
  /**
   * The Backend's own view of the task store. These are stored rows, not the Web's derived
   * summaries: the derived fields stay in the Web until the relay is enabled.
   */
  readTasks = () => [],
  readTask = () => null,
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
  /** Starts a session for a forwarded prompt; null when no runtime is attached. */
  promptTask = null,
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
  if (promptTask !== null && typeof promptTask !== "function") {
    throw new Error("promptTask must be a function or null");
  }
  for (const [name, handler] of Object.entries({
    respondToPermission,
    respondToQuestion,
    abortTask,
    botCodeRequestAction,
    goalLoopAction,
    createBotCodeSession,
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
    const actionSuffix = [BACKEND_TASK_PROMPT_SUFFIX, BACKEND_TASK_PERMISSION_SUFFIX, BACKEND_TASK_QUESTION_SUFFIX, BACKEND_TASK_ABORT_SUFFIX, BACKEND_TASK_GOAL_LOOP_SUFFIX]
      .find((suffix) => taskSuffix?.endsWith(suffix));
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
    // `<botId>/code-requests` acts on the Bot's outbox: only the owner may write it.
    const botActionSuffix = [BACKEND_BOT_CODE_REQUESTS_SUFFIX, BACKEND_BOT_CODE_SESSIONS_SUFFIX]
      .find((suffix) => botSuffix?.endsWith(suffix));
    const botActionPath = botActionSuffix === undefined || !botSuffix
      ? undefined
      : decodeURIComponent(botSuffix.slice(0, -botActionSuffix.length));
    const knownPath = target.pathname === BACKEND_HEALTH_PATH
      || target.pathname === BACKEND_PENDING_SNAPSHOTS_PATH
      || target.pathname === BACKEND_BOTS_PATH
      || botSuffix !== undefined
      || botActionPath !== undefined
      || taskPath !== undefined
      || detailPath !== undefined
      || actionPath !== undefined;
    if (!knownPath) {
      sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
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
      };
      const handler = actionSuffix ? handlers[actionSuffix] : undefined;
      if (typeof handler !== "function") {
        sendJson(response, 503, {
          error: "Backend runtime unavailable", code: BACKEND_ERROR_CODES.runtimeUnavailable,
        });
        return;
      }
      // Abort carries no payload beyond an optional Bot id, so an empty body is normal there.
      const body = actionSuffix === BACKEND_TASK_ABORT_SUFFIX
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
          const result = await handler(actionPath, body.value);
          const loop = action === "start" ? result?.loop : result;
          if (!loop) {
            sendJson(response, 404, { error: "Goal loop not found", code: BACKEND_ERROR_CODES.notFound });
            return;
          }
          sendJson(response, 200, action === "start"
            ? { loop, agent: result.agent ?? null, ...(result.autoDecision ? { autoDecision: result.autoDecision } : {}) }
            : { loop });
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
          sendJson(response, 200, { task: summary ?? null });
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
        // Never send exception text: provider errors can contain credentials.
        sendJson(response, typeof error?.status === "number" ? error.status : 500, {
          error: "Backend task action failed",
          code: BACKEND_ERROR_CODES.internal,
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
      const botHandler = botActionSuffix === BACKEND_BOT_CODE_SESSIONS_SUFFIX ? createBotCodeSession : botCodeRequestAction;
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
        if (botActionSuffix === BACKEND_BOT_CODE_SESSIONS_SUFFIX) {
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
      if (typeof readTaskDetail !== "function") {
        sendJson(response, 503, {
          error: "Backend runtime is not attached", code: BACKEND_ERROR_CODES.runtimeUnavailable,
        });
        return;
      }
      try {
        const detail = await readTaskDetail(detailPath);
        if (!detail) {
          sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
          return;
        }
        sendJson(response, 200, { detail });
      } catch (error) {
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
