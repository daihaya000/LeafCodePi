import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  BACKEND_ERROR_CODES,
  BACKEND_HEALTH_PATH,
  BACKEND_BOTS_PATH,
  BACKEND_PENDING_SNAPSHOTS_PATH,
  BACKEND_PROTOCOL_HEADER,
  BACKEND_PROTOCOL_VERSION,
  BACKEND_TASKS_PATH,
  DEFAULT_BACKEND_PORT,
} from "../../shared/backend-protocol.mjs";

function tokenDigest(value) {
  return createHash("sha256").update(value).digest();
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
    const detailPath = taskSuffix?.endsWith("/detail")
      ? decodeURIComponent(taskSuffix.slice(0, -"/detail".length))
      : undefined;
    const taskPath = target.pathname === BACKEND_TASKS_PATH
      ? null
      : taskSuffix !== null && detailPath === undefined
        ? decodeURIComponent(taskSuffix)
        : undefined;
    const botSuffix = target.pathname.startsWith(`${BACKEND_BOTS_PATH}/`)
      ? decodeURIComponent(target.pathname.slice(BACKEND_BOTS_PATH.length + 1))
      : undefined;
    const knownPath = target.pathname === BACKEND_HEALTH_PATH
      || target.pathname === BACKEND_PENDING_SNAPSHOTS_PATH
      || target.pathname === BACKEND_BOTS_PATH
      || botSuffix !== undefined
      || taskPath !== undefined
      || detailPath !== undefined;
    if (!knownPath) {
      sendJson(response, 404, { error: "Not found", code: BACKEND_ERROR_CODES.notFound });
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
        // Lets the frontend detect that the running Backend is an older/newer build than itself.
        runtimeGeneration: runtimeGeneration() ?? null,
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
