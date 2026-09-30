/** Internal transport only; never expose the backend token to browser code. */
export const BACKEND_PROTOCOL_VERSION = 1;
export const BACKEND_PROTOCOL_HEADER = "x-leafcode-backend-protocol";
export const BACKEND_HEALTH_PATH = "/internal/health";
/** Read-only: the pending snapshot per task, so a reconnecting WebUI can re-display state. */
export const BACKEND_PENDING_SNAPSHOTS_PATH = "/internal/pending-snapshots";
/** Read-only: the Backend's own view of the task store, before the Web relay is enabled. */
export const BACKEND_TASKS_PATH = "/internal/tasks";
/**
 * The suffix that turns a task path into its prompt endpoint: `POST /internal/tasks/:id/prompt`.
 * Only the owning process may start a session, so the WebUI forwards the request here.
 */
export const BACKEND_TASK_PROMPT_SUFFIX = "/prompt";

/**
 * The suffix that turns a task path into its detail endpoint: `GET /internal/tasks/:id/detail`.
 * The owning process reads the session; a WebUI that handed the runtime over reads it from here.
 */
export const BACKEND_TASK_DETAIL_SUFFIX = "/detail";

/**
 * Answering a pending approval or question in the owning process: `POST /internal/tasks/:id/permission`
 * and `POST /internal/tasks/:id/question`. The pending request itself never leaves the owner's memory.
 */
export const BACKEND_TASK_PERMISSION_SUFFIX = "/permission";
/** Stopping a running session: `POST /internal/tasks/:id/abort`, optionally with `{ botId }`. */
export const BACKEND_TASK_ABORT_SUFFIX = "/abort";
/**
 * Bot Code request actions: `POST /internal/bots/:id/code-requests` with `{ action, requestId }`.
 * Stopping a request also updates the Bot's outbox, which only the owning process may write.
 */
export const BACKEND_BOT_CODE_REQUESTS_SUFFIX = "/code-requests";
/**
 * Starting a Bot Code session: `POST /internal/bots/:id/code-sessions`. The session and its outbox
 * entry are created inside the owning process, which then runs it.
 */
export const BACKEND_BOT_CODE_SESSIONS_SUFFIX = "/code-sessions";
/**
 * Goal Loop control: `POST /internal/tasks/:id/goal-loop` with `{ action, maxTurns?, botId? }`.
 * The loop runs inside the owning process, so pause/resume/stop/complete must reach it.
 */
export const BACKEND_TASK_GOAL_LOOP_SUFFIX = "/goal-loop";
export const BACKEND_TASK_QUESTION_SUFFIX = "/question";

/** Read-only: the Backend's own view of the Bot store. */
export const BACKEND_BOTS_PATH = "/internal/bots";
export const DEFAULT_BACKEND_PORT = 18776;

/** Authentication precedes version checks, including health requests. */
export const BACKEND_ERROR_CODES = Object.freeze({
  unauthorized: "BACKEND_UNAUTHORIZED",
  incompatible: "BACKEND_PROTOCOL_MISMATCH",
  notFound: "BACKEND_NOT_FOUND",
  methodNotAllowed: "BACKEND_METHOD_NOT_ALLOWED",
  internal: "BACKEND_INTERNAL_ERROR",
  /** The Backend has no Pi runtime attached, so this read cannot be served yet. */
  runtimeUnavailable: "BACKEND_RUNTIME_UNAVAILABLE",
  /** The request itself was unusable: a malformed or oversized body. */
  badRequest: "BACKEND_BAD_REQUEST",
});
